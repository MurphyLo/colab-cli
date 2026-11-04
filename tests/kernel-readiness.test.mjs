import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { WebSocketServer } from 'ws';
import { KernelConnection } from '../.test-build/jupyter/kernel-connection.js';

const KERNEL = { id: 'kernel-1', name: 'julia' };

/** Minimal Jupyter server. `mock.denyChannels` / `mock.denySessions` hold a status to fail with. */
async function jupyter(t) {
  const mock = {
    denySessions: 0, denyChannels: 0, hangUpgrades: false, closeBeforeReady: 0,
    sessions: 0, restarts: 0, channels: 0, deletedKernel: false,
  };
  const server = http.createServer((req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && req.url.startsWith('/api/sessions')) {
      mock.sessions++;
      if (mock.denySessions) return json(mock.denySessions, {});
      return json(201, { id: 'session-1', name: 'colab-cli', path: '/colab-cli', type: 'console', kernel: KERNEL });
    }
    if (req.method === 'POST' && req.url === `/api/kernels/${KERNEL.id}/restart`) {
      mock.restarts++;
      return json(200, KERNEL);
    }
    json(404, {});
  });
  const wss = new WebSocketServer({
    noServer: true,
  });
  const hung = [];
  server.on('upgrade', (req, socket, head) => {
    if (mock.hangUpgrades) { hung.push(socket); return; }
    const reject = status => {
      socket.write(`HTTP/1.1 ${status} Denied\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (mock.denyChannels) return reject(mock.denyChannels);
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', ws => {
    mock.channels++;
    ws.on('message', raw => {
      const msg = JSON.parse(raw);
      const send = (channel, type, content) => ws.send(JSON.stringify({
        header: { msg_type: type, msg_id: `${type}-${Math.random()}` },
        parent_header: { msg_id: msg.header.msg_id }, metadata: {}, channel, content,
      }));
      if (msg.header.msg_type === 'kernel_info_request') {
        if (mock.closeBeforeReady > 0) { mock.closeBeforeReady--; ws.close(); return; }
        send('shell', 'kernel_info_reply', {});
      } else if (msg.header.msg_type === 'execute_request') {
        send('iopub', 'stream', { name: 'stdout', text: `ran ${msg.content.code}\n` });
        send('shell', 'execute_reply', { status: 'ok' });
        send('iopub', 'status', { execution_state: 'idle' });
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    for (const socket of hung) socket.destroy();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.closeAllConnections();
    server.close();
  });
  return [mock, `http://127.0.0.1:${server.address().port}`];
}

function connection(t, url) {
  const k = new KernelConnection(() => url, () => 'test', {}, 'test', KERNEL.name);
  t.after(() => k.close());
  return k;
}

test('a failed handshake is retried with the same kernel, without a second session', { timeout: 15000 }, async t => {
  const [mock, url] = await jupyter(t);
  mock.denyChannels = 503;
  const k = connection(t, url);
  setTimeout(() => { mock.denyChannels = 0; }, 500);
  await k.ensureReady();
  assert.equal(k.isConnected, true);
  assert.equal(mock.sessions, 1);
  assert.equal(mock.channels, 1);
});

test('concurrent callers share one attempt and a ready kernel makes no further connections', { timeout: 15000 }, async t => {
  const [mock, url] = await jupyter(t);
  const k = connection(t, url);
  await Promise.all([k.ensureReady(), k.ensureReady()]);
  await k.ensureReady();
  assert.equal(mock.sessions, 1);
  assert.equal(mock.channels, 1);
});

test('a client error fails fast and is not remembered by the next attempt', { timeout: 15000 }, async t => {
  const [mock, url] = await jupyter(t);
  mock.denySessions = 403;
  const k = connection(t, url);
  await assert.rejects(k.ensureReady(), /error code/);
  assert.equal(mock.sessions, 1);
  mock.denySessions = 0;
  await k.ensureReady();
  assert.equal(k.isConnected, true);
});

test('a kernel that no longer exists is replaced by a new session', { timeout: 15000 }, async t => {
  const [mock, url] = await jupyter(t);
  const k = connection(t, url);
  k.kernelId = 'deleted-kernel';
  mock.denyChannels = 404;
  setTimeout(() => { mock.denyChannels = 0; }, 500);
  await k.ensureReady();
  assert.equal(k.kernelId, KERNEL.id);
  assert.equal(mock.sessions, 1);
});

test('restart posts once and retries only the connection when it drops before ready', { timeout: 15000 }, async t => {
  const [mock, url] = await jupyter(t);
  const k = connection(t, url);
  await k.ensureReady();
  mock.closeBeforeReady = 1;
  await k.restartKernel();
  assert.equal(mock.restarts, 1);
  assert.equal(mock.channels, 3);
  assert.equal(k.isConnected, true);
});

test('a restart that cannot reconnect says so, and the next attempt recovers without restarting again', { timeout: 15000 }, async t => {
  const [mock, url] = await jupyter(t);
  const k = connection(t, url);
  await k.ensureReady();
  mock.denyChannels = 403;
  await assert.rejects(k.restartKernel(), /Kernel was restarted, but the connection could not be restored: .*403/);
  assert.equal(k.isConnected, false);
  mock.denyChannels = 0;
  await k.ensureReady();
  assert.equal(k.isConnected, true);
  assert.equal(mock.restarts, 1);
});

test('a socket left open by a failed restart is dropped, so the next attempt cannot use it', { timeout: 15000 }, async t => {
  // Colab's proxy keeps answering pings after Jupyter gives up on an unready
  // channel, so this socket looks healthy to the client but reaches nothing.
  const [mock, url] = await jupyter(t);
  const k = connection(t, url);
  await k.ensureReady();
  const waitForKernelReady = k.waitForKernelReady;
  k.waitForKernelReady = async () => { throw new Error('Unexpected server response: 403'); };
  await assert.rejects(k.restartKernel(), /could not be restored/);
  assert.equal(k.isConnected, false);
  assert.equal(k.journalReady, false);
  k.waitForKernelReady = waitForKernelReady;
  const channelsBefore = mock.channels;
  await k.ensureReady();
  assert.equal(mock.channels, channelsBefore + 1);
  assert.equal(k.isConnected, true);
  assert.equal(mock.restarts, 1);
});

test('restart supersedes an attempt stuck in its handshake, and later callers wait for the restart', { timeout: 15000 }, async t => {
  const [mock, url] = await jupyter(t);
  mock.hangUpgrades = true;
  const k = connection(t, url);
  k.kernelId = KERNEL.id;
  const stuck = k.ensureReady();
  const cancelled = assert.rejects(stuck, /cancelled/);
  await new Promise(resolve => setTimeout(resolve, 50));
  mock.hangUpgrades = false;
  const restart = k.restartKernel();
  const waiter = k.ensureReady();
  await cancelled;
  await Promise.all([restart, waiter]);
  assert.equal(k.isConnected, true);
  assert.equal(mock.restarts, 1);
  assert.equal(mock.channels, 1);
});

test('close cancels retries', { timeout: 15000 }, async t => {
  const [mock, url] = await jupyter(t);
  mock.denyChannels = 503;
  const k = connection(t, url);
  const pending = assert.rejects(k.ensureReady(), /cancelled/);
  await new Promise(resolve => setTimeout(resolve, 100));
  k.close();
  await pending;
});

async function daemon(t, url) {
  // Use a short path: Unix domain sockets have a small path length limit.
  const home = fs.mkdtempSync('/tmp/cr-');
  const id = '12345678-1234-4234-8234-123456789012';
  const config = path.join(home, '.config/colab-cli');
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'servers.json'), JSON.stringify([{
    id, label: 'test', variant: 'DEFAULT', endpoint: 'test', token: 'test', kernelName: KERNEL.name,
    proxyUrl: url, tokenExpiry: new Date(Date.now() + 3600000), dateAssigned: new Date(),
  }]));
  const child = fork(new URL('./fixtures/daemon-recovery-worker.mjs', import.meta.url), [id], {
    env: { ...process.env, TEST_HOME: home }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const socketPath = path.join(config, `daemon-${id}.sock`);
  while (!fs.existsSync(socketPath)) await new Promise(resolve => setTimeout(resolve, 20));
  const socket = net.connect(socketPath);
  t.after(() => {
    socket.destroy();
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  });
  const lines = readline.createInterface({ input: socket })[Symbol.asyncIterator]();
  const next = async () => JSON.parse((await lines.next()).value);
  assert.equal((await next()).type, 'ready');
  const send = msg => socket.write(JSON.stringify(msg) + '\n');
  const exec = async code => {
    send({ type: 'exec', code });
    const outputs = [];
    for (;;) {
      const msg = await next();
      if (msg.type === 'output') outputs.push(msg.output);
      else return { ...msg, outputs };
    }
  };
  return { send, next, exec };
}

test('daemon: exec retries after the first connection attempt failed', { timeout: 20000 }, async t => {
  const [mock, url] = await jupyter(t);
  mock.denySessions = 403;
  const d = await daemon(t, url);
  const failed = await d.exec('first');
  assert.equal(failed.type, 'exec_error');
  mock.denySessions = 0;
  const done = await d.exec('second');
  assert.equal(done.type, 'exec_done');
  assert.equal(done.outputs[0].text, 'ran second\n');
});

test('daemon: exec works after a restart repairs a failed first connection', { timeout: 20000 }, async t => {
  const [mock, url] = await jupyter(t);
  mock.denyChannels = 403;
  const d = await daemon(t, url);
  const failed = await d.exec('first');
  assert.equal(failed.type, 'exec_error');
  assert.match(failed.message, /403/);
  mock.denyChannels = 0;
  d.send({ type: 'restart' });
  assert.equal((await d.next()).type, 'restarted');
  const done = await d.exec('second');
  assert.equal(done.type, 'exec_done');
  assert.equal(done.outputs[0].text, 'ran second\n');
  assert.equal(mock.restarts, 1);
});
