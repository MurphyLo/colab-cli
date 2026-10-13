# Network recovery

Network changes do not restart the remote runtime or resubmit Python code.

- Kernel and terminal WebSockets ping every 15 seconds, terminating a socket if
  its pong is missing for 10 seconds. This detects a half-open transport, not
  necessarily a stalled backend behind a responsive proxy.
- Reconnect attempts continue with exponential delays capped at 30 seconds.
  Explicit connection close / kernel restart cancels outstanding recovery.
- Kernel recovery keeps the same kernel ID, client session ID and execution
  message handler. It accepts offline replay and requires both the original
  `execute_reply` and its IOPub `idle`. A kernel-info reply or unrelated idle is
  never evidence that the execution succeeded or failed.
- `exec list` shows `reconnecting` during recovery and `unknown` afterwards while
  waiting for the original final messages. The execution remains reserved so
  another exec cannot accidentally duplicate its side effects. Received output
  is retained. `exec clear` and history GC do not delete these active records.
- If final messages were permanently lost, `unknown` can remain indefinitely.
  Inspect the task through its files / an independent shell; do not blindly
  resubmit it. This patch does not implement a remote execution journal or
  lossless daemon restart / adoption. An explicit kernel restart still resets
  Python state and ends the tracked execution.
- A recovered final status does **not** certify complete output: messages sent
  before the server noticed the disconnect may be absent. Connection warnings
  stay in the execution log. Offline buffering was behaviorally verified on an
  isolated CPU runtime; it is not a guarantee for every Colab runtime.
- Terminal recovery sends the original tmux attachment command before accepting
  user input. `shell list` reports `reconnecting`. Input during disconnect or
  recovery is rejected, not queued or replayed. Send acknowledgements wait for
  the WebSocket write callback: this confirms local transport acceptance, not
  remote command execution. A network failure after acceptance is ambiguous.
- Stdin send failures preserve the pending prompt. Detaching the CLI also keeps
  pending stdin so `exec send --stdin` or a subsequent attach can answer it.
- File metadata / directory operations and upload / download requests retry
  transient failures, by default up to six attempts with exponential backoff.
  Python split/assembly commands are not automatically replayed. Downloads
  validate size and publish using a sibling temporary file plus rename, keeping
  any old destination on validation/write failure. Upload resumption across CLI
  invocations is not implemented; an ambiguous upload completion needs checking.

## Validation and deployment

`npm test` compiles to `.test-build` and runs local mock-server / fault tests.
It does not contact Colab, read credentials, or restart any daemon. Tests cover
half-open sockets, repeated retry failure, original-session replay (including
reply-before-output ordering), uncertain completion, input errors, tmux restore
ordering and atomic downloads.

`npm run build` updates `dist`; `npm link` only updates the executable link.
Neither replaces the code already loaded by a running daemon. Deploy the new
local daemon after its active work has finished. A remote runtime restart or
recreation is not required for these transport changes. The existing daemon's
active execution/session tracking cannot yet be migrated losslessly.
