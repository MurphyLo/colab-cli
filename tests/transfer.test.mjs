import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeDownloadAtomic, transferRetry } from '../.test-build/transfer/common.js';
import { downloadFile } from '../.test-build/transfer/download.js';

function destination(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'colab-transfer-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'result');fs.writeFileSync(file,'previous');return file;
}
test('truncated downloads preserve the existing destination; complete data publishes atomically', t=>{
  const file=destination(t);
  assert.throws(()=>writeDownloadAtomic(file,[Buffer.from('short')],10),/size mismatch/);
  assert.equal(fs.readFileSync(file,'utf8'),'previous');
  writeDownloadAtomic(file,[Buffer.from('new'),Buffer.from(' data')],8);
  assert.equal(fs.readFileSync(file,'utf8'),'new data');
  assert.deepEqual(fs.readdirSync(path.dirname(file)),['result']);
});
test('filesystem metadata and content recover from transient errors before writing', async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const file=destination(t);let metadata=0,content=0;
  t.mock.method(globalThis,'fetch',async url=>{
    if(url.endsWith('?content=0')) {
      if(++metadata===1)throw new TypeError('network lost');
      return new Response(JSON.stringify({type:'file',size:4}));
    }
    if(++content===1)return new Response('busy',{status:503});
    return new Response(JSON.stringify({type:'file',format:'base64',content:Buffer.from('data').toString('base64')}));
  });
  const result=downloadFile({getProxyUrl:()=> 'http://test',getToken:()=>''},{remotePath:'result',localPath:file},()=>{throw new Error('must not execute code');});
  for(let i=0;i<30;i++){for(let n=0;n<15;n++)await Promise.resolve();t.mock.timers.tick(30000);}
  await result;assert.equal(metadata,2);assert.equal(content,2);assert.equal(fs.readFileSync(file,'utf8'),'data');
});
test('permanent HTTP failures are not retried',async()=>{
  let attempts=0;
  await assert.rejects(transferRetry(async()=>{attempts++;throw Object.assign(new Error('forbidden'),{status:403});}),/forbidden/);
  assert.equal(attempts,1);
});
