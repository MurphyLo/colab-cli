// A real process boundary, isolated from user configuration and Colab.
import os from 'node:os';
os.homedir = () => process.env.TEST_HOME;
const { ExecutionStore } = await import('../../.test-build/daemon/execution-store.js');
const { KernelConnection } = await import('../../.test-build/jupyter/kernel-connection.js');
const store = new ExecutionStore('test-runtime');
const old = store.recoverable();
const id = old?.id ?? store.create('side_effect()');
const kernel = new KernelConnection(() => process.env.TEST_URL, () => 'test', {}, 'test', 'python3', async () => {});
const checkpoint = (state, output) => {
  const result = store.checkpoint(id, state, output);
  const stop = process.env.STOP_AFTER;
  if ((stop === 'reply' && state.gotExecuteReply) ||
      (stop === 'error' && state.replyError) ||
      (stop === 'idle' && state.gotIdle) ||
      (stop === 'both' && state.gotIdle && state.gotExecuteReply) ||
      (stop === 'input' && state.pendingInput) ||
      (stop === 'auth' && state.pendingAuth) ||
      (stop === 'stream' && output?.type === 'stream')) {
    process.kill(process.pid, 'SIGKILL');
  }
  return result;
};
try {
  let outputs;
  if (old) outputs = kernel.resume(old.recovery, checkpoint);
  else {
    kernel.kernelId = 'original-kernel';
    await kernel.connectWebSocket();
    outputs = await kernel.execute('side_effect()', checkpoint);
  }
  for await (const output of outputs) {
    if (output.type === 'input_request') await kernel.sendStdinReply('answer');
  }
  store.complete(id);
  process.send({ type: 'done', execution: store.get(id) });
} catch (error) {
  process.send({ type: 'error', error: String(error) });
  process.exitCode = 1;
} finally {
  kernel.close();
  process.disconnect();
}
