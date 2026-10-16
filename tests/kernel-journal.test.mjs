import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { KernelConnection } from '../.test-build/jupyter/kernel-connection.js';
import { parseJournal, readJournal } from '../.test-build/jupyter/kernel-journal.js';

async function fixture(t) {
  const records = []; let fail = false;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('.jsonl')) res.end(JSON.stringify({ content: records.map(x => JSON.stringify(x)+'\n').join('') }));
    else res.end(JSON.stringify({ content: [{ name: '000000000001.jsonl' }, ...(fail ? [{name:'FAILED'}] : [])] }));
  });
  const wss = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const k = new KernelConnection(() => `http://127.0.0.1:${server.address().port}`, () => '', {}, 'test');
  k.kernelId = 'kernel'; k.journalReady = true;
  t.after(() => { k.close(); for(const ws of wss.clients) ws.terminate(); wss.close(); server.close(); });
  let request, ws;
  wss.on('connection', socket => { ws=socket; socket.on('message',raw=>{const m=JSON.parse(raw);if(m.header.msg_type==='execute_request')request=m;}); });
  await k.connectWebSocket();
  const append=(type,content,channel='iopub')=>{
    const seq=records.length+1;
    const m={seq,header:{msg_type:type},parent_header:{msg_id:request.header.msg_id},content,channel,metadata:{colab_cli_journal:{exec:request.header.msg_id,seq,ok:true}}};
    records.push(m);return m;
  };
  return {k,records,append,send:m=>ws.send(JSON.stringify(m)),failed:()=>{fail=true;},ready:async()=>{while(!request)await new Promise(r=>setTimeout(r,1));}};
}

test('journal repairs missing output and terminal signals, ordering duplicate WS and HTTP messages', {timeout:5000}, async t=>{
 const f=await fixture(t);const saved=[];const stream=await f.k.execute('side_effect()',s=>{saved.push(structuredClone(s));});
 const output=[];const consume=(async()=>{for await(const x of stream)output.push(x);})();await f.ready();
 const first=f.append('stream',{name:'stdout',text:'one'});
 f.append('stream',{name:'stdout',text:'two'});
 const reply=f.append('execute_reply',{status:'ok'},'shell');
 f.append('status',{execution_state:'idle'});
 f.send(reply); f.send(first); f.send(first);
 await f.k.reconcileJournal();await consume;
 assert.deepEqual(output.filter(x=>x.type==='stream').map(x=>x.text),['one','two']);
 assert.equal(saved.at(-1).journal.cursor,4);
 assert.equal(saved.at(-1).gotIdle,true);
});

test('no live final message needed; HTTP recovery also restores a lost input request', {timeout:5000}, async t=>{
 const f=await fixture(t);const stream=await f.k.execute('input()');const next=stream.next();await f.ready();
 f.append('input_request',{prompt:'value?',password:false},'stdin');await f.k.reconcileJournal();
 assert.equal((await next).value.type,'input_request');
 f.append('execute_reply',{status:'ok'},'shell');f.append('status',{execution_state:'idle'});
 await f.k.reconcileJournal();assert.equal((await stream.next()).done,true);
});

test('journal failure reports incomplete output but keeps tracking until the real terminal messages', {timeout:5000}, async t=>{
 const f=await fixture(t);const stream=await f.k.execute('work()');const next=stream.next();await f.ready();
 f.failed();await f.k.reconcileJournal();
 assert.equal((await next).value.ename,'JournalIntegrityError');
 assert(f.k.recovery.journal.failure);assert.equal(f.k.recovery.gotIdle,false);
 f.send(f.append('execute_reply',{status:'ok'},'shell'));f.send(f.append('status',{execution_state:'idle'}));
 assert.equal((await stream.next()).done,true);
});

test('missing hook delivers live output with explicit capture failure instead of hanging', {timeout:5000}, async t=>{
 const f=await fixture(t);const stream=await f.k.execute('work()');const outputs=[];
 const consuming=(async()=>{for await(const x of stream) outputs.push(x);})();await f.ready();
 for(const m of [f.append('stream',{name:'stdout',text:'hello'}),f.append('execute_reply',{status:'ok'},'shell'),f.append('status',{execution_state:'idle'})]){delete m.metadata.colab_cli_journal;f.send(m);}
 await consuming;assert(outputs.some(x=>x.ename==='JournalIntegrityError'));assert(outputs.some(x=>x.text==='hello'));assert.equal(f.k.journalReady,false);
});

test('checkpointed cursor skips old rows on resume without resubmitting', {timeout:5000}, async t=>{
 const f=await fixture(t);const stream=await f.k.execute('work()');const first=stream.next();await f.ready();
 f.send(f.append('stream',{name:'stdout',text:'old'}));await first;
 const recovery=structuredClone(f.k.recovery);await stream.return();
 f.append('stream',{name:'stdout',text:'new'});f.append('execute_reply',{status:'ok'},'shell');f.append('status',{execution_state:'idle'});
 const result=[];for await(const x of f.k.resume(recovery))result.push(x);
 assert.deepEqual(result.filter(x=>x.type==='stream').map(x=>x.text),['new']);
});

test('parser waits for partial final writes and rejects corrupt complete records',()=>{
 const row={seq:1,header:{},content:{}};
 assert.deepEqual(parseJournal(JSON.stringify(row)+'\n{"seq":'),[row]);
 assert.throws(()=>parseJournal('broken\n'));
});

test('bootstrap failure blocks journal readiness', async()=>{
 const k=new KernelConnection(()=>'',()=>'',{},'test');
 k.execute=async()=> (async function*(){yield {type:'error',evalue:'read only'};})();
 await assert.rejects(k.installJournal(),/installation failed/);assert.equal(k.journalReady,false);
});

test('journaled stdin keeps ambiguous reply reserved and clears it only on matching receipt', async t=>{
 const f=await fixture(t);const stream=await f.k.execute('input()');const next=stream.next();await f.ready();
 f.append('input_request',{prompt:'value?',password:true},'stdin');await f.k.reconcileJournal();await next;
 await f.k.sendStdinReply('secret');const id=f.k.recovery.pendingInputReplyId;
 assert(f.k.recovery.pendingInput);assert(id);
 await assert.rejects(f.k.sendStdinReply('secret'),/unverified/);
 f.append('colab_cli_input_received',{reply_msg_id:'wrong'});await f.k.reconcileJournal();assert(f.k.recovery.pendingInput);
 f.append('colab_cli_input_received',{reply_msg_id:id});await f.k.reconcileJournal();assert.equal(f.k.recovery.pendingInput,undefined);
 f.append('execute_reply',{status:'ok'},'shell');f.append('status',{execution_state:'idle'});await f.k.reconcileJournal();assert.equal((await stream.next()).done,true);
 assert(!JSON.stringify(f.records).includes('secret'));
});

test('Colab authorization without parent request ID is recovered through journal ordering', async t=>{
 const f=await fixture(t);let calls=0;f.k.requestEphemeralAuth=async()=>{calls++;};
 const stream=await f.k.execute('auth()');const next=stream.next();await f.ready();
 const auth=f.append('colab_request',{request:{authType:'auth_user_ephemeral'}});
 auth.parent_header={session:'client'};Object.assign(auth.metadata,{colab_request_type:'request_auth',colab_msg_id:42});
 await f.k.reconcileJournal();assert.equal(calls,1);
 f.send(auth);await f.k.reconcileJournal();assert.equal(calls,1);
 f.append('execute_reply',{status:'ok'},'shell');f.append('status',{execution_state:'idle'});await f.k.reconcileJournal();assert.equal((await next).done,true);
});

test('completed journal cleanup deletes recognized files before their directory', async t=>{
 const {removeJournal}=await import('../.test-build/jupyter/kernel-journal.js');const requests=[];
 const server=http.createServer((req,res)=>{requests.push([req.method,req.url]);res.setHeader('Content-Type','application/json');res.end(req.method==='GET'?JSON.stringify({content:[{name:'000000000001.jsonl'},{name:'000000000010.jsonl'}]}):'null');});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 await removeJournal(`http://127.0.0.1:${server.address().port}`,'','session','request');
 assert.deepEqual(requests.map(x=>x[0]),['GET','DELETE','DELETE','DELETE']);assert(requests[1][1].endsWith('000000000001.jsonl'));assert(requests.at(-1)[1].endsWith('/request'));
});


test('guarded input permits retry and accepts receipt of either answer for the same prompt', async t=>{
 const f=await fixture(t);const stream=await f.k.execute('input()');const next=stream.next();await f.ready();
 const prompt=f.append('input_request',{prompt:'value?',password:true},'stdin');
 prompt.header.msg_id='prompt-1';prompt.metadata.colab_cli_input_guard=true;
 await f.k.reconcileJournal();await next;
 await f.k.sendStdinReply('secret');const first=f.k.recovery.pendingInputReplyId;
 await f.k.sendStdinReply('secret');assert.notEqual(first,f.k.recovery.pendingInputReplyId);
 f.append('colab_cli_input_received',{reply_msg_id:first,request_id:'prompt-1'});await f.k.reconcileJournal();
 assert.equal(f.k.recovery.pendingInput,undefined);
 await assert.rejects(f.k.sendStdinReply('late'),/not waiting/);
 f.append('execute_reply',{status:'ok'},'shell');f.append('status',{execution_state:'idle'});
 await f.k.reconcileJournal();assert.equal((await stream.next()).done,true);
});

test('journal polling skips unchanged files but reads a growing segment',async t=>{
 let size=1,reads=0;
 const server=http.createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url.includes('.jsonl')){reads++;res.end(JSON.stringify({content:JSON.stringify({seq:size,header:{},content:{}})+'\n'}));}
  else res.end(JSON.stringify({content:[{name:'000000000001.jsonl',size,last_modified:'stable'}]}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 const url=`http://127.0.0.1:${server.address().port}`,cache=new Map();
 assert.equal((await readJournal(url,'','session','exec',0,cache)).length,1);
 assert.equal((await readJournal(url,'','session','exec',1,cache)).length,0);assert.equal(reads,1);
 size=2;assert.equal((await readJournal(url,'','session','exec',1,cache))[0].seq,2);assert.equal(reads,2);
});
