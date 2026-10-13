import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

test('clear and history GC preserve unknown, reconnecting, input and auth executions', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'colab-store-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  t.mock.method(os,'homedir',()=>dir);
  const { ExecutionStore }=await import('../.test-build/daemon/execution-store.js');
  const store=new ExecutionStore('isolated-test');
  const unknown=store.create('a');store.appendOutput(unknown,{type:'status',executionState:'unknown'});
  const reconnecting=store.create('b');store.appendOutput(reconnecting,{type:'status',executionState:'reconnecting'});
  const input=store.create('c');store.setPendingInput(input,'prompt',false);
  const auth=store.create('d');store.setPendingAuth(auth,'auth_user');
  for(let i=0;i<60;i++){const id=store.create('done');store.complete(id);}
  store.clear();
  for(const id of [unknown,reconnecting,input,auth])assert.ok(store.get(id));
  assert.equal(store.list().length,4);
});
