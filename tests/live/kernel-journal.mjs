// Opt-in real Colab test; creates/deletes only its own isolated kernel.
import assert from 'node:assert/strict';
import {KernelConnection} from '../../dist/jupyter/kernel-connection.js';
import {getStoredServer} from '../../dist/runtime/storage.js';
import {contentsRequest} from '../../dist/jupyter/contents-client.js';
const s=getStoredServer(process.argv[2]);
if (!s) throw new Error('Usage: node --use-env-proxy tests/live/kernel-journal.mjs <stored-server-uuid>');
const remote=await contentsRequest(s.proxyUrl,s.token,'/api/kernels',{method:'POST',body:{name:'python3'}});
console.log('Isolated test kernel:', remote.id);
let offline=false;
const k=new KernelConnection(()=>offline?'http://127.0.0.1:1':s.proxyUrl,()=>s.token,{},s.endpoint,'python3',async()=>{});
k.kernelId=remote.id;
const timer=setTimeout(()=>{console.log('TIMEOUT');k.close();},90000);
try {
 await k.connectWebSocket();await k.waitForKernelReady();await k.installJournal();console.log('installed',k.journalReady);
 let fault=false;const output=[];
 for await(const x of await k.execute("import time\nfor n in range(25):\n print('SEQ',n,flush=True);time.sleep(.2)\nprint('DONE',flush=True)")){
  output.push(x);
  if(x.type==='stream'&&!fault){fault=true;offline=true;k.ws.removeAllListeners('message');setTimeout(()=>{offline=false;k.ws.terminate();},8000);console.log('injected offline');}
 }
 const text=output.filter(x=>x.type==='stream').map(x=>x.text).join('');
 assert.deepEqual([...text.matchAll(/SEQ (\d+)/g)].map(m=>Number(m[1])),Array.from({length:25},(_,i)=>i));assert.match(text,/DONE/);console.log('PASS offline completion 25/25');
 while (!k.isConnected) await new Promise(r=>setTimeout(r,200));
 const input=[];
 for await(const x of await k.execute("import getpass; a=input('first?'); b=getpass.getpass('second?'); print('GOT',a,b)")){
  input.push(x);
  if(x.type==='input_request')await k.sendStdinReply(x.prompt==='first?'?'one':'two');
 }
 assert.match(input.filter(x=>x.type==='stream').map(x=>x.text).join(''),/GOT one two/);console.log('PASS input');
 const rich=[];for await(const x of await k.execute("from IPython.display import display,HTML,Image\ndisplay(HTML('<b>test</b>'))\ndisplay(Image(data=__import__('base64').b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=')))\n21*2"))rich.push(x);
 assert(rich.some(x=>x.data?.['image/png']));assert(rich.some(x=>x.data?.['text/html']));assert(rich.some(x=>x.data?.['text/plain']==='42'));console.log('PASS rich output');
 const errors=[];
 for await(const x of await k.execute("raise ValueError('expected')")) errors.push(x);
 assert(errors.some(x=>x.type==='error'&&x.ename==='ValueError'));
 const interrupted=[];let sent=false;
 for await(const x of await k.execute("print('INTERRUPT_READY',flush=True)\ntime.sleep(60)")) {
   interrupted.push(x);
   if(x.type==='stream'&&!sent){sent=true;await k.interrupt();}
 }
 assert(interrupted.some(x=>x.type==='error'&&x.ename==='KeyboardInterrupt'));
 console.log('PASS exception and interrupt');
 const auth=[];
 for await (const x of await k.execute("from google.colab import _message\nr=_message.send_request('request_auth',{'authType':'auth_user_ephemeral'})\n_message.read_reply_from_input(r,timeout_sec=10)\nprint('AUTH_REPLY_OK')")) auth.push(x);
 assert.match(auth.filter(x=>x.type==='stream').map(x=>x.text).join(''),/AUTH_REPLY_OK/);
 console.log('PASS Colab request/reply routing (credential propagation mocked)');
 console.log('PASS all checks');
} finally {clearTimeout(timer);k.close();await contentsRequest(s.proxyUrl,s.token,'/api/kernels/'+remote.id,{method:'DELETE'});}
