import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { KernelConnection } from '../.test-build/jupyter/kernel-connection.js';
import { TerminalConnection } from '../.test-build/terminal/terminal-connection.js';
import { monitorWebSocket, reconnectDelay } from '../.test-build/utils/websocket-health.js';

const delay = ms => new Promise(r => setTimeout(r, ms));
async function server(t) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  t.after(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
  return [wss, `http://127.0.0.1:${wss.address().port}`];
}
function kernel(url) {
  const k = new KernelConnection(() => url, () => 'test', {}, 'test');
  k.kernelId = 'original-kernel';
  return k;
}

test('half-open socket terminates without a pong; healthy socket stays open', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  for (const healthy of [false, true]) {
    const ws = new EventEmitter(); ws.readyState = 1;
    let terminated = false;
    ws.ping = () => { if (healthy) ws.emit('pong'); };
    ws.terminate = () => { terminated = true; };
    const stop = monitorWebSocket(ws, 15, 10);
    for (let i=0;i<10;i++) t.mock.timers.tick(10);
    assert.equal(terminated, !healthy);
    stop();
    assert.equal(ws.listenerCount('pong'), 0);
  }
});

test('kernel reconnect keeps identity and drains reply-before-output replay without resubmission', { timeout: 10000 }, async t => {
  const [wss, url] = await server(t);
  const k = kernel(url); t.after(() => k.close());
  let connections = 0, requests = 0, originalRequest;
  const urls = [];
  wss.on('connection', (ws, req) => {
    connections++; urls.push(req.url);
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      assert.equal(m.header.msg_type, 'execute_request'); // no kernel_info abort probe
      requests++; originalRequest = m.header.msg_id;
      ws.terminate();
    });
    if (connections === 2) {
      const send = (channel, type, content) => ws.send(JSON.stringify({
        header: { msg_type: type }, parent_header: { msg_id: originalRequest }, channel, content,
      }));
      send('shell', 'execute_reply', { status: 'ok' });
      send('iopub', 'stream', { name: 'stdout', text: 'replayed\n' });
      send('iopub', 'status', { execution_state: 'idle' });
    }
  });
  await k.connectWebSocket();
  const output = [];
  for await (const o of await k.execute('side_effect()')) output.push(o);
  assert.equal(requests, 1);
  assert.equal(connections, 2);
  assert.equal(urls[0], urls[1]);
  assert.match(urls[0], /original-kernel\/channels\?session_id=/);
  assert.equal(output.filter(o => o.type === 'stream')[0].text, 'replayed\n');
  assert.ok(output.some(o => o.executionState === 'reconnecting'));
});

for (const kind of ['kernel', 'terminal']) {
  test(`${kind} recovers after more than five failures and stops retries on close`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let closed = 0, reconnected = 0, attempts = 0;
    const c = kind === 'kernel' ? kernel('unused') : new TerminalConnection(() => '', () => '', {
      onData() {}, onOpen() {}, onClose() { closed++; }, onError() {},
      onReconnected() { reconnected++; },
    });
    c.connectWebSocket = async () => {
      attempts++;
      if (attempts <= 7) throw new Error('offline');
      c.ws = { readyState: 1, removeAllListeners() {}, on() {}, terminate() {} };
    };
    c.scheduleReconnect(1006, 'offline');
    for (let i=0;i<8;i++) {
      t.mock.timers.tick(30000);
      for (let n=0;n<5;n++) await Promise.resolve();
    }
    assert.equal(attempts, 8);
    assert.equal(c.isConnected, true);
    assert.equal(c.isReconnecting, false);
    assert.equal(closed, 0);
    if (kind === 'terminal') assert.equal(reconnected, 1);
    c.close();
    t.mock.timers.tick(1000000);
    assert.equal(attempts, 8);
    assert.equal(reconnectDelay(1000), 30000);
  });
}

test('terminal and stdin reject disconnected input instead of silently acknowledging it', async () => {
  const c = new TerminalConnection(() => '', () => '', { onData() {}, onOpen() {}, onClose() {}, onError() {} });
  await assert.rejects(c.send('dangerous command\n'), /not sent/);
  const k = kernel('');
  await assert.rejects(k.sendStdinReply('answer'), /not sent/);
  c.close(); k.close();
});

test('execute_reply error cannot become success when its IOPub error was lost', async t => {
  const [wss, url] = await server(t);
  wss.on('connection', ws => ws.on('message', raw => {
    const id = JSON.parse(raw).header.msg_id;
    for (const [channel, type, content] of [
      ['shell','execute_reply',{status:'error',ename:'ValueError',evalue:'failed'}],
      ['iopub','status',{execution_state:'idle'}],
    ]) ws.send(JSON.stringify({header:{msg_type:type},parent_header:{msg_id:id},channel,content}));
  }));
  const k = kernel(url); t.after(() => k.close()); await k.connectWebSocket();
  const output=[];for await(const o of await k.execute('raise ValueError()')) output.push(o);
  assert.equal(output[0].type,'error'); assert.equal(output[0].ename,'ValueError');
});

test('missing final messages keep execution reserved; unrelated idle is not success', async t => {
  const [wss,url]=await server(t);
  let ws;
  wss.on('connection', s => { ws=s; });
  const k=kernel(url); t.after(()=>k.close()); await k.connectWebSocket();
  const output=[];
  const consume=(async()=>{for await(const o of await k.execute('work()'))output.push(o);})();
  // Attach rejection handler before explicit close.
  const rejected=assert.rejects(consume,/remote execution may still be running/);
  await delay(10);
  ws.send(JSON.stringify({header:{msg_type:'status'},parent_header:{msg_id:'other'},channel:'iopub',content:{execution_state:'idle'}}));
  await delay(20);
  assert.ok(k.activeExecutionAbort);
  k.close(); await rejected;
});

test('terminal restores its session before accepting new input', { timeout: 10000 }, async t => {
  const [wss,url]=await server(t);let connections=0;const received=[];
  let restored;const ready=new Promise(r=>restored=r);
  const c=new TerminalConnection(()=>url,()=>'',{
    onData(){},onOpen(){},onClose(){},onError(){},
    async onReconnected(sendInput){
      await assert.rejects(c.send('must not reach default terminal'),/not sent/);
      await sendInput('restore original tmux');restored();
    },
  });t.after(()=>c.close());
  wss.on('connection',ws=>{
    connections++;
    ws.on('message',raw=>received.push(JSON.parse(raw).data));
    if(connections===1)setTimeout(()=>ws.terminate(),10);
  });
  await c.connect();await ready;await delay(10);await c.send('user input');await delay(10);
  assert.deepEqual(received,['restore original tmux','user input']);
});

test('transport write failures propagate to callers', async () => {
  const socket={readyState:1,send(_data,callback){callback(new Error('write failed'));}};
  const k=kernel('');k.ws=socket;
  await assert.rejects(k.sendStdinReply('answer'),/write failed/);
  const c=new TerminalConnection(()=>'',()=>'',{});c.ws=socket;
  await assert.rejects(c.send('input'),/write failed/);
});

for (const kind of ['kernel', 'terminal']) {
  test(`${kind} close cancels an opening handshake without unhandled errors`, async t => {
    const { createServer } = await import('node:http');
    const server=createServer();
    server.listen(0,'127.0.0.1');await once(server,'listening');
    let incoming;const upgrade=new Promise(resolve=>server.on('upgrade',(_req,socket)=>{incoming=socket;resolve();}));
    t.after(()=>{incoming?.destroy();server.close();});
    const url=`http://127.0.0.1:${server.address().port}`;
    const c=kind==='kernel'?kernel(url):new TerminalConnection(()=>url,()=>'',{onData(){},onOpen(){},onClose(){},onError(){}});
    const pending=c.connectWebSocket();
    const rejected=assert.rejects(pending,/cancelled/);
    await upgrade;c.close();await rejected;
    assert.equal(c.isReconnecting,false);
  });
}
