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
- For legacy executions and non-Python kernels, if final messages were permanently lost, `unknown` can remain indefinitely.
  Inspect the task through its files / an independent shell; do not blindly
  resubmit it. These legacy paths do not have a remote journal. An explicit kernel restart still resets
  Python state and ends the tracked execution.
- On those legacy paths, a recovered final status does **not** certify complete output: messages sent
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

### Daemon restart adoption

New executions checkpoint their kernel ID, client session ID, request message ID,
completion signals, and pending stdin/auth state in the local execution log.
The initial checkpoint is flushed before submitting code; subsequent output and
protocol progress are written together before notifying an attached CLI.

After a daemon restart, the unfinished execution reserves the execution slot.
Its handler is installed before reconnecting to the original kernel/session, so
immediate Jupyter replay can be processed. Adoption sends neither another
`execute_request` nor a `kernel_info` readiness probe. Partial completion signals
survive restarts. Pending stdin can be answered through `exec send --stdin` or
`exec attach`; pending Colab authorization is re-established by the daemon.

The foreground CLI's IPC connection does not automatically reconnect. Use
`colab exec list` and `colab exec attach <id>` after restarting the daemon; these
commands start the daemon if necessary. An execution remains `unknown` when
original completion messages are unavailable, rather than being resubmitted.
If the daemon dies between checkpointing a request and sending it, that request
also remains uncertain: recovery intentionally never sends the code again.

Only executions started by the updated daemon have recovery metadata. Old
unfinished logs cannot be retroactively adopted. Server buffering can still be
lost (including when another client replaces the buffered session); kernel/VM
loss cannot be repaired by local checkpoints. Input delivery acknowledged by
the local WebSocket is not a guarantee of remote receipt. Stdin values/passwords
are not checkpointed or automatically resent.

Shell/tmux adoption and resuming an entire `fs` transfer are outside this change.
Only the kernel execution steps within chunked transfers use this tracking.

`npm test` compiles to `.test-build` and runs local mock-server / fault tests.
It does not contact Colab, read credentials, or restart any daemon. Tests cover
half-open sockets, repeated retry failure, original-session replay (including
reply-before-output ordering), uncertain completion, input errors, tmux restore
ordering and atomic downloads. Adoption tests kill and replace real child
processes at output, completion, stdin and auth boundaries, and exercise the
daemon's IPC attach/send and shutdown paths against a local mock backend.

`npm run build` updates `dist`; `npm link` only updates the executable link.
Neither replaces the code already loaded by a running daemon. Deploy the new
local daemon after its active work has finished. A remote runtime restart or
recreation is not required for these transport changes. An older running daemon
must finish its active execution before deployment: it has not written the new
recovery checkpoints.

## Python message journal

New Python connections install and confirm a versioned `Session.send`/`recv`
instance hook before accepting user code. Installation is silent and excluded
from history. No extra process, listening port, code wrapper or stdout replacement
is used. A failed installation prevents new user code from being submitted.

The hook writes each tracked message to a private, per-session/per-request NDJSON
journal under `/tmp/colab-cli-journal-v1`, with monotonic sequence metadata, before
sending it. Files roll at approximately 1 MiB (one large message may exceed that).
Writes reach the OS page cache before sending (no per-message fsync); metadata, MIME content and binary buffers are kept. A KeyboardInterrupt is not converted into a journal failure; masking SIGINT in the sending thread does not defer it, because CPython raises it in the main thread after any other kernel thread receives the signal. Serialization uses Jupyter json_default.
Colab authorization messages without a parent request ID are associated with the
current matching shell session. Password/input values are not journaled.

The daemon merges live messages and Contents API reads by sequence. It checkpoints
each applied sequence together with its output/protocol state. Reconciliation runs
on adoption, reconnect, gaps, and every three seconds after ten seconds of silence. Unchanged segment size/mtime avoids repeated file downloads. HTTP failures/404 defer recovery;
they never prove the request was not executed. Original reply **and** idle must
be consumed in order before completion. Corrupt records or a failed journal are
explicit errors, never silent missing output. Partial final lines wait for the
next read. Journal failure or a missing hook emits an explicit error and continues live tracking until the original terminal messages; it does not declare the kernel crashed or release its slot early. Completeness is no longer guaranteed in this degraded mode. Installation failures are retried before the next submission.

Stdin replies retain pending state until a journaled remote receipt, a subsequent
prompt, or completion. Guarded answers carry a prompt ID and can be manually retried; the kernel discards answers for stale prompts. Legacy hooks without this guard reject ambiguous retries. Receipt is not a guarantee user code consumed the
answer successfully. Values/passwords are neither checkpointed nor replayed.

After the daemon fsyncs the local terminal record it best-effort deletes that
execution's remote journal. Failed cleanup retains files; there is no age-based
expiry of unfinished logs. Runtime loss removes remote files. Disk failure,
user tampering with hooks/files, kernel death and power loss are not transparent
network recovery; no exactly-once execution claim is made. Already submitted
legacy records and R/Julia keep their previous behavior. Shell and full transfer
orchestration are unchanged.

`tests/kernel-journal.test.mjs` covers missing output/completion, duplicates,
ordering, lost prompts, cursor adoption, corrupt journals and bootstrap failure.
The opt-in `tests/live/kernel-journal.mjs <stored-server-uuid>` creates an isolated
kernel on an existing runtime, blocks live receiving and HTTP reads until remote
completion, then verifies output recovery, stdin and rich results. Run after
`npm run build` with `node --use-env-proxy` and your normal proxy environment.
It is not run by `npm test` and does not destroy the runtime.

### Recorded acceptance (2026-10-16)

On a real CPU Colab runtime, a user-controlled Wi-Fi outage of approximately
60 seconds left the daemon PID unchanged. All 90 numbered outputs matched the
independent remote file byte-for-byte after recovery, with one START and a
persisted done event. A separate SIGKILL/restart during a 30-output execution
changed the daemon PID and recovered all 30 outputs, also with one START and done.
The opt-in isolated-kernel test additionally covers completion while both live
receiving and HTTP reads are blocked, rich outputs, input/getpass, exceptions,
interrupt and Colab request/reply routing (credential propagation mocked).
These are concrete acceptance runs, not guarantees for kernel/VM or disk loss.

### Review follow-up validation

The follow-up to `5e69d20` covers dense-display SIGINT, Jupyter-compatible
numpy/bytes metadata, missing-hook detection/reinstallation, retrying a dropped
stdin answer with prompt fencing, and unchanged-segment read suppression.
The opt-in live test retains these cases alongside offline completion recovery.

Remaining boundaries: Colab authorization reply acknowledgement still follows the
existing local-send path; the prompt-ID retry guard applies to ordinary stdin.
Missing execute-request acceptance remains uncertain and is never retried.
Failed journals are retained for diagnosis, and per-execution hook bookkeeping
is retained for the lifetime of the kernel; output from background threads after
idle may recreate a cleaned journal. These are not covered by this follow-up.
