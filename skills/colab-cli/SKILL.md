---
name: colab-cli
description: "Use this skill whenever the user wants to operate Google Colab from the terminal: authenticate, inspect available runtimes, create or destroy a runtime, restart a kernel, check CCU usage, execute Python remotely, open or manage interactive shell sessions, upload or download files to a Colab runtime, manage files in Google Drive through `colab drive`, or mount Drive on a runtime via `colab drive-mount`. Prefer this skill even if the user does not mention `colab-cli` explicitly but asks to use a Colab GPU or TPU, run code on Colab from a shell, open a terminal on the runtime, move files to `/content`, move large files through Drive, mount Drive automatically, or troubleshoot Colab auth, Drive auth, quota, proxy, shell, or runtime lifecycle issues."
metadata:
  short-description: Use the `colab` CLI for auth, runtime, exec, shell, fs, usage, Drive, and Drive mount tasks
---

# Colab CLI

Use the `colab` command.

Treat `colab --help` and `colab <subcommand> --help` as the source of truth for exact flags. Use the guidance below to choose the right workflow quickly and consistently.

## Preconditions

- Confirm the CLI is available with `colab --help` if the environment is unclear.
- For `runtime`, `exec`, `fs`, and `usage`, check login state with `colab auth status` before acting.
- If Colab auth is missing, use `colab auth login` and explain that it opens a browser OAuth flow.
- `colab drive ...` uses a separate OAuth flow from `colab auth login`. The first Drive command may open a separate browser authorization step.
- `colab drive-mount` requires `COLAB_DRIVEFS_CLIENT_ID` and `COLAB_DRIVEFS_CLIENT_SECRET` environment variables. Without them the command is hidden and the standard browser-based ephemeral auth flow is used.
- If the machine is behind a proxy, export the relevant proxy environment variables (e.g., `HTTPS_PROXY`) before calling `colab`.
- If the command is missing, ensure Node.js is installed, then clone the repository (e.g., `git clone https://github.com/Murphylo/colab-cli.git`), navigate into it, and run `npm install`, `npm run build`, and `npm link`.

## Default Workflow

1. Choose the surface:
   - Use `colab runtime`, `colab exec`, `colab shell`, and `colab fs` for runtime lifecycle, remote execution, interactive terminal access, and `/content` file transfer.
   - Use `colab drive` for Google Drive file management or when the user needs a large-file path outside direct runtime filesystem transfer.
2. Verify the relevant auth:
   - `colab auth status` for runtime-side operations.
   - Expect an independent OAuth prompt on first `colab drive ...` use.
3. Inspect context with `colab runtime available`, `colab runtime list`, or `colab usage` when the task depends on capacity, endpoint choice, or quota state.
4. Execute the requested operation. Note that restarting a runtime may be necessary during execution (e.g., after updating dependencies, when a command hangs, or to clear variables).
5. Destroy a runtime only when the user asks for it.

When a command could act on multiple runtimes, prefer identifying the target explicitly with `colab runtime list` before using `--endpoint`.

## Runtime Semantics

- Runtime accelerators use Colab UI names such as `CPU`, `T4`, `A100`, `L4`, `G4`, `H100`, `v6e-1`, and `v5e-1`.
- Shapes use `standard` or `high-ram`.

## JSON Output (`--json`)

Most commands accept a global `--json` flag (`exec` excluded). When set, spinners are suppressed and the result is written as a single JSON object to stdout. Use this for scripting and automation.

```bash
# Extract a folder ID reliably
FOLDER_ID=$(colab drive mkdir models --parent "$PARENT" --json | jq -r '.folderId')

# Extract a runtime endpoint
ENDPOINT=$(colab runtime create --accelerator T4 --shape standard --json | jq -r '.endpoint')
```

Every JSON object includes a `command` field (e.g. `"drive.mkdir"`, `"runtime.create"`). Command-level failures return `{"error":"..."}` with a non-zero exit code.

Login commands (`auth login`, `drive login`, `drive-mount login`) in `--json` mode are **non-blocking**: they output `{"event":"auth_required","authType":"...","url":"...","timeoutSeconds":120}` and exit immediately. A background daemon waits for the OAuth callback (up to the timeout). After the user completes login in the browser, poll the corresponding `status --json` command to confirm success.

When building scripts that chain folder creation or runtime operations, always use `--json` to avoid parsing spinner output.

## Command Patterns

### Authentication

```bash
colab auth login
colab auth status
colab auth logout
```

Use `login` for first-time setup or expired Colab credentials. Use `status` as the first diagnostic step when runtime-side auth is in doubt.

### Runtime Discovery And Lifecycle

```bash
colab runtime available
colab runtime versions
colab runtime create --accelerator CPU
colab runtime create --accelerator T4 --shape standard
colab runtime create --accelerator T4 --runtime-version 2025.10
colab runtime create --accelerator L4 --shape high-ram
colab runtime list
colab runtime restart --endpoint <endpoint>
colab runtime destroy --endpoint <endpoint>
```

Use `available` before creation when the user wants to know what their account can launch. Use `versions` to list available runtime versions and their environment details (Python, PyTorch, etc.). Use `--runtime-version` with `create` to pin a specific version. Use `list` whenever endpoint selection matters.

### Usage

```bash
colab usage
```

Use this when the user asks about subscription tier, remaining CCU balance, refill timing, or hourly burn rate.

### Remote Code Execution

```bash
colab exec "
x = 6 * 7
print('value:', x)
for i in range(3):
    print('row', i)
"
colab exec --file script.py
colab exec --endpoint <endpoint> "import torch; print(torch.cuda.is_available())"
colab exec --output-dir ./plots "import matplotlib.pyplot as plt; plt.plot([1,2,3]); plt.show()"
```

- Use inline code for short snippets.
- Use `--file` for multi-line scripts or when shell quoting would be fragile.
- Use `--output-dir <dir>` to save image outputs (PNG, JPEG, GIF, SVG) to a specific directory. Without `--output-dir`, images are saved automatically to `~/.config/colab-cli/outputs/<serverId>/`. File names follow `exec<id>-output-<n>.<ext>` for cross-execution isolation. The saved file path is printed to the terminal.
- **Interactive input**: Code using `input()` or `getpass.getpass()` works transparently — prompts are forwarded to the terminal, user input is sent back to the kernel, and execution continues. Password prompts (`getpass`) suppress character echo automatically. In non-TTY contexts (e.g., piped stdin), an empty string is returned immediately.
- **Ctrl+C interrupt**: Pressing Ctrl+C during execution sends an interrupt signal to the Colab kernel (equivalent to the stop button in the Colab UI). The kernel raises `KeyboardInterrupt`, the traceback is printed, and the CLI exits with a non-zero status. A second Ctrl+C force-exits the CLI immediately. This also works during `input()` prompts — Ctrl+C interrupts the kernel instead of sending input.
- If the executed Python code raises an exception, `colab exec` exits non-zero.
- If the code mounts Google Drive or requests an ephemeral Google credential, the foreground CLI may open a consent flow and continue after approval. If `colab drive-mount` was run beforehand, `drive.mount()` detects the existing mount and skips auth entirely.
- **Background execution** (`--background`): The CLI returns immediately with an exec ID (printed to stdout) while the kernel continues executing. Use `exec attach`, `exec list`, and `exec send` to monitor and interact with background executions. If background code triggers browser auth, the daemon stores the auth URL, snapshot/streaming attach commands print it, and the daemon retries credential propagation automatically every 5 seconds until the browser flow completes or times out. Only one execution (foreground or background) can run at a time — the Jupyter kernel is serial. For commands that must run alongside a long-running exec (GPU/memory diagnostics, file inspection, side tasks), use `colab shell` — it uses a separate TTY channel that is not subject to the kernel's serial execution.

### Background Execution Management

```bash
colab exec --background "import time; [print(i) or time.sleep(1) for i in range(60)]"
colab exec list
colab exec attach 1 --no-wait
colab exec attach 1 --tail 20
colab exec attach 1
colab exec send 1 --stdin "yes"
colab exec send 1 --interrupt
colab exec clear
colab exec clear 1
```

- Use `--background` to run long tasks without blocking the CLI (exec ID printed to stdout).
- Use `exec list` to see all executions and their status (`running`, `done`, `error`, `crashed`, `input`, or `auth`) and elapsed time.
- Use `exec attach <id> --no-wait` to get a snapshot of buffered output and exit immediately. If the execution is paused on browser auth, the stored OAuth URL is printed in that snapshot.
- Use `exec attach <id> --tail <n>` to get only the last N outputs (implies `--no-wait`, so `--no-wait` can be omitted).
- Use `exec attach <id>` (without `--no-wait`) to replay buffered output and continue streaming live output until the execution finishes. If the execution is paused on browser auth, streaming attach also prints the stored OAuth URL before waiting.
- Use `exec send <id> --stdin "value"` to respond to a pending `input()` prompt in a background execution.
- Use `exec send <id> --interrupt` to interrupt (Ctrl+C equivalent) a background execution.
- Use `exec clear` to remove all completed executions, or `exec clear <id>` to remove a specific one. Running and input-waiting executions are preserved.
- If `input()` is called during background execution with no client attached, execution waits until stdin is delivered via `exec send <id> --stdin` or a client attaches.
- `--interrupt` only delivers SIGINT to the kernel. Children spawned with `start_new_session=True` / `nohup` / `setsid` or daemon-ized survive and `colab exec` cannot reach them — clean up via `colab shell`.

### Interactive Shell Sessions

```bash
colab shell
colab shell --background
colab shell list
colab shell attach 1 --no-wait
colab shell attach 1 --tail 4096
colab shell attach 1
colab shell send 1 --data "ls -la\\n"
colab shell send 1 --signal INT
```

- Use `colab shell` for a foreground interactive terminal on the latest runtime (or add `--endpoint <endpoint>` when the target matters).
- Use `colab shell --background` when the caller cannot block on an interactive TTY; it prints a shell ID and leaves the daemon attached to `/colab/tty`.
- Multiple shell sessions on the same runtime run in parallel and are independent — opening a new shell does not disturb existing ones, and each has its own output buffer.
- Use `colab shell list` to inspect active shell sessions and whether a client is currently attached.
- Use `colab shell attach <id> --no-wait` to print buffered output immediately and exit. Use `--tail <bytes>` to limit the replay window by bytes, not lines.
- Use `colab shell attach <id>` to replay buffered output and continue streaming live output. If another client is already attached, it will be detached and notified.
- Use `colab shell send <id> --data ...` to inject raw bytes into a detached shell. Escape sequences such as `\\n` and `\\x03` are supported.
- Use `colab shell send <id> --signal INT|EOF|TSTP|QUIT` for common control characters. `INT` is Ctrl+C, `EOF` is Ctrl+D, `TSTP` is Ctrl+Z, and `QUIT` maps to Ctrl+\.
- In a foreground shell session, `Ctrl+\` is intercepted locally to detach the CLI without sending the byte to the remote shell.
- Closed shell sessions remain visible briefly so users can inspect final buffered output before daemon cleanup evicts them.

### Port Forwarding

```bash
colab port-forward create 7860
colab port-forward create 18080:7860
colab port-forward list
colab port-forward close 1
colab port-forward close --all
```

- Use `colab port-forward create <spec>` where `<spec>` is `REMOTE`, `LOCAL:REMOTE`, or `HOST:LOCAL:REMOTE`.
- `pf` is a shorter alias for `port-forward`.
- Forwards are HTTP/WebSocket only (L7 reverse proxy through Colab edge infrastructure). Raw TCP protocols (PostgreSQL, Redis, SSH, gRPC) are not supported.
- The forward runs inside the daemon; `create` returns immediately after the local listener is bound.
- Forwards live as long as the daemon. If the runtime is destroyed or the daemon is killed, all forwards are cleared and must be recreated.
- Use `colab port-forward list` to see active forwards with their IDs, bind host, local/remote ports, and proxy URLs.
- Use `colab port-forward close <id>` or `--all` to tear down forwards.
- Typical use cases: Gradio, Streamlit, Flask/FastAPI, TensorBoard, dev servers.

### Runtime Filesystem Transfer

```bash
colab fs upload ./data.csv
colab fs upload ./model.bin --remote-path content/models/model.bin
colab fs download content/results.json
colab fs download content/output.bin --output ./local-output.bin
```

- Use `colab fs` for files moving directly between local disk and the runtime filesystem, usually under `content/...`.
- Transfers up to 500 MiB are handled directly or via chunking.
- If the file is larger than 500 MiB, or the user wants the asset to live in Drive instead of `/content`, switch to `colab drive`.

### Google Drive

```bash
colab drive list
colab drive list <folder-id>
colab drive upload ./dataset.zip --parent <folder-id>
colab drive download <file-id> --output ./dataset.zip
colab drive mkdir "checkpoints" --parent <folder-id>
colab drive move <item-id> --to <folder-id>
colab drive delete <file-id>
colab drive delete <file-id> --permanent
```

- `colab drive` has its own OAuth session and does not rely on `colab auth login`.
- Drive commands use file IDs and folder IDs, not human-readable names or path strings. If the user only knows a name, list the folder first to find the ID.
- `colab drive list` can also show files shared with you, and `drive move` copies items you do not own instead of moving them.
- `drive upload` is resumable for large files and can continue after interruption by re-running the same command.
- For large assets, durable storage, or workflows that rely on `drive.mount('/content/drive')`, prefer `colab drive` over `colab fs`.

### Automatic Drive Mounting

```bash
colab drive-mount login                  # One-time: authorize (opens browser)
colab drive-mount                        # Mount Drive on the latest runtime
colab drive-mount --endpoint <endpoint>  # Mount on a specific runtime
colab drive-mount status                 # Check authorization status
```

- Requires `COLAB_DRIVEFS_CLIENT_ID` and `COLAB_DRIVEFS_CLIENT_SECRET` environment variables.
- One-time `login` saves a persistent refresh token. After that, `drive-mount` works without browser interaction on any new runtime.
- Drive is mounted at `/content/drive`. Python code calling `drive.mount('/content/drive')` will detect the existing mount and return immediately.
- When the env vars are not set, this command group is hidden and the standard browser-based auth flow is used as fallback.

### Choosing `fs` vs `drive`

- Use `colab fs` when the target is the live runtime filesystem and the file size is within the direct/chunked transfer path.
- Use `colab drive` when the user explicitly mentions Google Drive, needs persistence outside the runtime, or the file size exceeds the `fs` chunked limit.
- Use `colab drive-mount` when the user wants to access Drive files from the runtime without browser auth prompts.
- If the user wants a file visible inside Colab after mounting Drive, upload it with `colab drive` rather than forcing it into `/content`.

## Troubleshooting

- `412` or `503` during `runtime create` usually means Colab-side quota, capacity, or assignment pressure rather than a local transport bug.
- Colab auth state is stored at `~/.config/colab-cli/auth.json`.
- Runtime state is stored at `~/.config/colab-cli/servers.json`.
- Drive auth state is stored at `~/.config/colab-cli/drive-auth.json`.
- Resumable Drive upload state is stored under `~/.config/colab-cli/drive-uploads/`.
- Image outputs from `exec` are saved under `~/.config/colab-cli/outputs/<serverId>/`.
- Execution history (background and foreground) is stored under `~/.config/colab-cli/exec-logs-<server-id>/`.
- If `colab shell send` reports that the shell was not found or is closed, the daemon has already cleaned it up or the shell has exited; run `colab shell list` to confirm the current shell IDs.
- `colab shell attach --tail <n>` uses bytes, not lines.
- If a Drive command fails because the input looks like a filename instead of an ID, run `colab drive list` first and use the actual file or folder ID.
- If `input()` prompts are not appearing or return empty, check that stdin is a TTY. In non-TTY mode (piped input, CI), prompts are skipped and empty strings are returned.
- If Ctrl+C does not interrupt a long-running kernel execution, press Ctrl+C a second time to force-exit the CLI process.
- If a script needs to capture command output (IDs, endpoints, paths), always use `--json`. Without it, all human-readable output goes to stderr via the spinner and `$(...)` will capture nothing.
- Drive quota or OAuth client issues can be addressed by setting `COLAB_DRIVE_CLIENT_ID` and `COLAB_DRIVE_CLIENT_SECRET`, then re-running a Drive command to re-authorize.
- For exact flag syntax or new subcommands, re-check `colab --help` or the relevant subcommand help instead of guessing.

## Response Style

- State which runtime endpoint you are using when the command is endpoint-sensitive.
- State clearly whether you are operating on the runtime filesystem or Google Drive.
- Quote code snippets and file paths conservatively to avoid shell parsing mistakes.
- Summarize outcomes in terms the user cares about: auth status, selected accelerator, endpoint, execution result, uploaded file, downloaded path, Drive file ID, Drive folder ID, or quota state.
- Keep the workflow terminal-first.
