import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import net from 'node:net';
import readline from 'node:readline';

for (const stop of ['stream', 'reply', 'error', 'idle', 'both', 'input', 'auth']) {
  test(`new process adopts after ${stop}, with original identity and no code resubmission`, { timeout: 15000 }, async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'colab-adoption-'));
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(wss, 'listening');
    const children = [];
    t.after(() => {
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      fs.rmSync(home, { recursive: true, force: true });
    });
    let requestId, submissions = 0, replies = 0;
    const urls = [];
    wss.on('connection', (ws, req) => {
      urls.push(req.url);
      const send = (channel, type, content) => ws.send(JSON.stringify({
        header: { msg_type: type }, parent_header: { msg_id: requestId }, channel, content,
      }));
      const reply = () => send('shell', 'execute_reply', stop === 'error'
        ? { status: 'error', ename: 'ValueError', evalue: 'failed' } : { status: 'ok' });
      const idle = () => send('iopub', 'status', { execution_state: 'idle' });
      ws.on('message', raw => {
        const msg = JSON.parse(raw);
        if (msg.header.msg_type === 'input_reply') {
          replies++;
          if (stop === 'auth') assert.equal(msg.content.value.colab_msg_id, 42);
          else assert.equal(msg.content.value, 'answer');
          reply(); idle();
          return;
        }
        assert.equal(msg.header.msg_type, 'execute_request', 'adoption must not send a readiness probe');
        submissions++;
        requestId = msg.header.msg_id;
        send('iopub', 'stream', { name: 'stdout', text: 'before restart\n' });
        if (['reply', 'error', 'both'].includes(stop)) reply();
        if (stop === 'idle' || stop === 'both') idle();
        if (stop === 'input') send('stdin', 'input_request', { prompt: 'value?', password: false });
        if (stop === 'auth') ws.send(JSON.stringify({
          header: { msg_type: 'colab_request' }, parent_header: { msg_id: requestId },
          content: { request: { authType: 'auth_user_ephemeral' } },
          metadata: { colab_request_type: 'request_auth', colab_msg_id: 42 },
        }));
      });
      if (urls.length === 2 && !['input', 'auth'].includes(stop)) {
        // Replay immediately, before the new process's connect promise resumes.
        if (stop !== 'both') send('iopub', 'stream', { name: 'stdout', text: 'after restart\n' });
        if (!['reply', 'error', 'both'].includes(stop)) reply();
        if (stop !== 'idle' && stop !== 'both') idle();
      }
    });
    function launch(stopAfter) {
      const child = fork(new URL('./fixtures/recovery-worker.mjs', import.meta.url), [], {
        env: { ...process.env, TEST_HOME: home, TEST_URL: `http://127.0.0.1:${wss.address().port}`, STOP_AFTER: stopAfter },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      children.push(child);
      return child;
    }
    const first = launch(stop);
    const [, signal] = await once(first, 'exit');
    assert.equal(signal, 'SIGKILL');
    const second = launch('');
    const result = new Promise((resolve, reject) => {
      second.on('message', msg => msg.type === 'done' ? resolve(msg.execution) : reject(new Error(msg.error)));
      second.on('exit', code => { if (code) reject(new Error(`worker exited ${code}`)); });
    });
    const execution = await result;
    assert.equal(execution.id, 1);
    assert.equal(execution.status, stop === 'error' ? 'error' : 'done');
    if (stop === 'error') assert.equal(execution.outputs.filter(o => o.ename === 'ValueError').length, 1);
    assert.equal(submissions, 1);
    assert.equal(urls.length, 2);
    assert.equal(urls[0], urls[1]);
    assert.equal(execution.outputs.filter(o => o.text === 'before restart\n').length, 1);
    assert.equal(replies, ['input', 'auth'].includes(stop) ? 1 : 0);
    await once(second, 'exit');
  });
}

test('daemon reserves recovered execution, restores stdin over IPC and survives another shutdown', { timeout: 15000 }, async t => {
  // Use a short path: Unix domain sockets have a small path length limit.
  const home = fs.mkdtempSync('/tmp/ca-');
  const id = '12345678-1234-4234-8234-123456789012';
  const config = path.join(home, '.config/colab-cli');
  const logDir = path.join(config, `exec-logs-${id}`);
  fs.mkdirSync(logDir, { recursive: true });
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  fs.writeFileSync(path.join(config, 'servers.json'), JSON.stringify([{
    id, label: 'test', variant: 'DEFAULT', endpoint: 'test', token: 'test',
    proxyUrl: `http://127.0.0.1:${wss.address().port}`,
    tokenExpiry: new Date(Date.now() + 3600000), dateAssigned: new Date(),
  }]));
  fs.writeFileSync(path.join(logDir, '1.ndjson'), [
    { event: 'start', code: 'input()', startedAt: new Date().toISOString(), outputDir: home },
    { event: 'checkpoint', recovery: {
      kernelId: 'original-kernel', clientSessionId: 'original-client', msgId: 'original-request',
      gotExecuteReply: false, gotIdle: false, gotError: false,
      pendingInput: { type: 'input_request', prompt: 'value?', password: false },
    } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const children = [], sockets = [];
  t.after(() => {
    for (const s of sockets) s.destroy();
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  let requests = 0;
  wss.on('connection', (ws, req) => {
    assert.match(req.url, /original-kernel\/channels\?session_id=original-client/);
    ws.on('message', raw => {
      const msg = JSON.parse(raw);
      requests++;
      assert.equal(msg.header.msg_type, 'input_reply');
      assert.equal(msg.content.value, 'answer');
      for (const [channel, type, content] of [
        ['iopub', 'stream', { name: 'stdout', text: 'finished\n' }],
        ['shell', 'execute_reply', { status: 'ok' }],
        ['iopub', 'status', { execution_state: 'idle' }],
      ]) ws.send(JSON.stringify({ header: { msg_type: type }, parent_header: { msg_id: 'original-request' }, channel, content }));
    });
  });
  async function start() {
    const connection = once(wss, 'connection');
    const child = fork(new URL('./fixtures/daemon-recovery-worker.mjs', import.meta.url), [id], {
      env: { ...process.env, TEST_HOME: home }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    await connection;
    const socket = net.connect(path.join(config, `daemon-${id}.sock`));
    sockets.push(socket);
    const lines = readline.createInterface({ input: socket })[Symbol.asyncIterator]();
    const next = async () => JSON.parse((await lines.next()).value);
    assert.equal((await next()).type, 'ready');
    return { child, socket, next, send: msg => socket.write(JSON.stringify(msg) + '\n') };
  }
  let ipc = await start();
  ipc.send({ type: 'exec', code: 'must_not_run()', background: true });
  assert.match((await ipc.next()).message, /already executing/);
  const stopped = once(ipc.child, 'exit');
  ipc.child.kill('SIGTERM');
  assert.equal((await stopped)[0], 0);
  ipc = await start();
  ipc.send({ type: 'exec_attach', execId: 1 });
  let msg;
  do { msg = await ipc.next(); } while (msg.type === 'output');
  assert.equal(msg.type, 'input_request');
  ipc.send({ type: 'stdin_reply', value: 'answer' });
  do { msg = await ipc.next(); } while (msg.type === 'output');
  assert.equal(msg.type, 'exec_done');
  ipc.send({ type: 'exec_list' });
  assert.equal((await ipc.next()).executions[0].status, 'done');
  assert.equal(requests, 1);
  const exited = once(ipc.child, 'exit');
  ipc.child.kill('SIGTERM');
  await exited;
});
