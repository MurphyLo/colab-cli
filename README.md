# colab-cli

A terminal-first CLI for Google Colab — create runtimes, execute Python on GPUs/TPUs, and manage files, all from the command line. Many implementation patterns are adapted from [`colab-vscode`](https://github.com/googlecolab/colab-vscode) and [`jupyter-kernel-client`](https://github.com/googlecolab/jupyter-kernel-client).

This tool supports:

- **`colab auth`** / **`colab usage`** — Manage Google OAuth login, sessions, check subscription/CCU usage
- **`colab runtime`** — List available options, create, destroy, restart runtimes, and check resource usage
- **`colab exec`** — Execute Python code with full terminal I/O, streaming output, and background mode
- **`colab shell`** — Interactive terminal sessions with attach/detach and background mode
- **`colab port-forward`** — Forward runtime ports to your local machine via HTTP/WebSocket proxy
- **`colab fs`** — Upload and download files between your local filesystem and the runtime
- **`colab drive`** — Manage Google Drive files and folders directly from the terminal
- **`colab drive-mount`** — Mount Google Drive on a runtime without browser prompts (one-time setup)

## Requirements

- Node.js 22+
- A Google account with Colab access

## Install

```bash
npm install
npm run build
npm link
```

After `npm link`, the `colab` command points to your local build. Run `npm run build` (or keep `npm run dev` running) to pick up code changes — no need to re-link.

## Commands

### Authentication

```bash
colab auth login    # sign in via browser OAuth flow
colab auth status   # check current session
colab auth logout   # sign out
```

> Credentials: `~/.config/colab-cli/auth.json`

### Runtime

```bash
colab runtime available    # list options for the current account
colab runtime versions     # list runtime versions and environment details
```

Create a runtime by accelerator and shape:

```bash
colab runtime create --accelerator CPU
colab runtime create --accelerator T4 --shape standard
colab runtime create --accelerator v6e-1 --shape high-ram
colab runtime create --accelerator T4 --runtime-version 2025.10   # pin to specific version
colab runtime create --accelerator T4 --kernel r                  # R kernel
```

```bash
colab runtime list                       # list active runtimes
colab runtime resources                  # show RAM, disk and GPU usage
colab runtime destroy --endpoint <ep>    # destroy a runtime
colab runtime restart --endpoint <ep>    # restart kernel without destroying the VM
```

> Runtime state: `~/.config/colab-cli/servers.json`

### Usage

Shows subscription tier and CCU usage:

```bash
colab usage
```

### Execute Code

Run inline Python or a file:

```bash
colab exec "print('hello')"
colab exec -f script.py
colab exec -e <endpoint> "..."    # target a specific runtime
```

For code with nested quotes or shell metacharacters, pipe via stdin to bypass local escaping:

```bash
colab exec <<'EOF'
import os
print(f"hello {os.environ['USER']}")
EOF
```

Save image outputs (PNG/JPEG/GIF/SVG) to a directory:

```bash
colab exec -o ./plots "..."    # saved path printed to terminal
```

> Default image output dir: `~/.config/colab-cli/outputs/<serverId>/`

- `input()` and `getpass` prompts are forwarded to the terminal; password prompts suppress echo.
- Ctrl+C sends a kernel interrupt — also works during `input()` prompts. A second Ctrl+C force-exits.
- Exceptions exit non-zero.
- If code calls `drive.mount()`, the CLI handles the OAuth consent flow. With `colab drive-mount` pre-configured, the mount returns immediately.

#### Background Execution

```bash
colab exec --background "import time; time.sleep(60)"    # returns exec ID immediately
colab exec list                                          # list all executions
```

Statuses: `running`, `done`, `error`, `crashed`, `input` (waiting for stdin), `auth` (waiting for browser OAuth).

```bash
colab exec attach 1             # replay buffered output then stream live (blocks until done)
colab exec attach 1 --no-wait   # snapshot buffered output and exit
colab exec attach 1 --tail 20   # last 20 outputs only
```

```bash
colab exec send 1 --stdin "yes"    # send stdin to a running execution
colab exec send 1 --interrupt       # Ctrl+C equivalent
```

```bash
colab exec clear      # clear all completed executions
colab exec clear 3    # clear a specific execution by ID
```

- Running and input-waiting executions are preserved; only completed (`done`, `error`, `crashed`) entries are removed.
- The kernel is serial — only one execution runs at a time.
- For tasks that need to run alongside a long exec (diagnostics, file inspection), use `colab shell` — it runs on a separate TTY channel.
- `--interrupt` only reaches the kernel; subprocesses spawned with `start_new_session=True` or `nohup` survive and must be cleaned up via `colab shell`.
- When status is `auth`, any `attach` variant prints the stored OAuth URL; the daemon auto-retries credential propagation every 5s after the browser flow completes.

### Interactive Shell

```bash
colab shell              # open interactive terminal; press Ctrl+\ to detach
colab shell -b           # start detached, prints shell ID
colab shell list         # list active sessions
```

Multiple shell sessions on the same runtime run in parallel and are independent.

```bash
colab shell attach 1              # replay buffered output then stream live
colab shell attach 1 --no-wait   # snapshot buffered output and exit
colab shell attach 1 --tail 40   # last 40 lines
```

```bash
colab shell send 1 --data 'ls -la\n'    # send raw data (escape sequences supported)
colab shell send 1 --signal INT          # Ctrl+C
colab shell send 1 --signal EOF          # Ctrl+D
colab shell send 1 --signal TSTP         # Ctrl+Z
colab shell send 1 --signal QUIT         # Ctrl+\
```

For commands with nested quotes or shell metacharacters, pipe via stdin to bypass local escaping. Use `<<'EOF'` (quoted delimiter) to prevent local variable expansion and allow single quotes inside the body:

```bash
colab shell send 1 <<'EOF'
export LD_LIBRARY_PATH=$(python -c 'import sysconfig; print(sysconfig.get_config_var("LIBDIR"))'):$LD_LIBRARY_PATH
EOF
```

For simple one-liners without embedded single quotes, single-quoting `--data` is enough: `--data 'echo $HOME\n'`.

### Port Forwarding

Forward a runtime port to your local machine via an HTTP/WebSocket reverse proxy — no ngrok or runtime-side agent needed.

```bash
colab port-forward create 7860                 # REMOTE (binds 127.0.0.1 by default)
colab port-forward create 18080:7860           # LOCAL:REMOTE
colab port-forward create 0.0.0.0:18080:7860   # HOST:LOCAL:REMOTE
colab port-forward list
colab port-forward close 1
colab port-forward close --all
```

`pf` is a shorter alias for `port-forward`.

- HTTP and WebSocket only — raw TCP (PostgreSQL, Redis, SSH, gRPC) is not supported.
- Forwards live as long as the daemon; a destroyed runtime or killed daemon clears all forwards.

### File Transfer

Transfer files between local disk and the runtime's `/content` directory:

```bash
colab fs upload ./data.csv
colab fs upload ./model.bin -r content/models/model.bin
colab fs download content/results.json
colab fs download content/output.bin -o ./local-output.bin
```

Transfer strategy is chosen automatically by file size:

| File size | Strategy |
|-----------|----------|
| ≤ 20 MiB | Single REST request |
| 20–500 MiB | 20 MiB chunks, up to 25 parallel |
| > 500 MiB | Use `colab drive upload` / `colab drive download` |

### Google Drive

Drive uses a **separate OAuth flow** from Colab auth. Sign in before using Drive commands:

```bash
colab drive login                             # authorize Google Drive access
colab drive logout                            # remove stored credentials
colab drive status                            # show authorization status
colab drive list [folder-id]                  # list files (default: root)
colab drive upload <local-path> [-p <id>]     # upload file (resumable for >5 MiB)
colab drive download <file-id> [-o <path>]    # download file
colab drive mkdir <name> [-p <id>]            # create folder
colab drive delete <file-id> [--permanent]    # delete (default: trash)
colab drive move <item-id> --to <folder-id>   # move file or folder
```

> Credentials: `~/.config/colab-cli/drive-auth.json`

All commands use **file/folder IDs** (not names) — use `drive list` to find them.

- **Resumable upload**: Files >5 MiB use Google's resumable protocol; re-run the same command to resume an interrupted upload.
- **MD5 dedup**: Skips upload if an identical file already exists in the target folder.

#### Shared with me

Use `shared` as the folder ID to browse files shared with you:

```bash
colab drive list shared
```

- `drive move` on a file you don't own falls back to a copy; `--json` output includes `"mode": "moved"` or `"mode": "copied"`.
- `drive delete` is rejected for files you don't own.

#### Custom OAuth Credentials

If you hit Drive quota limits, set your own GCP OAuth client:

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/) and enable the **Google Drive API**
2. Create an **OAuth 2.0 Client ID** (Desktop app) and publish the consent screen
3. Set environment variables and re-authorize:

```bash
export COLAB_DRIVE_CLIENT_ID=your-client-id.apps.googleusercontent.com
export COLAB_DRIVE_CLIENT_SECRET=your-client-secret
colab drive login
```

### Automatic Drive Mounting

Mount Drive on a runtime without browser prompts on each new runtime (one-time setup required):

```bash
colab drive-mount login          # authorize once (opens browser)
colab drive-mount                # mount on the latest runtime
colab drive-mount -e <endpoint>  # mount on a specific runtime
colab drive-mount status
colab drive-mount logout
```

> Credentials: `~/.config/colab-cli/drive-mount-auth.json`

Drive is mounted at `/content/drive`. Subsequent `drive.mount('/content/drive')` calls in Python detect the existing mount and return immediately.

### JSON Output (Scripting)

Most commands support `--json` for machine-readable output (`exec` and `shell` excluded). Progress and prompts go to stderr; results go to stdout.

Login commands in `--json` mode are non-blocking — they emit an `auth_required` event with the OAuth URL and exit immediately while a background daemon waits for the browser callback. Poll the corresponding `status --json` to confirm.

```bash
colab drive mkdir models -p "$PARENT_ID" --json
# => {"command":"drive.mkdir","name":"models","folderId":"1Abc...","parentId":"1Xyz..."}

colab auth login --json
# => {"event":"auth_required","authType":"colab","url":"https://accounts.google.com/...","timeoutSeconds":120}
```

Scripting example — building a nested Drive folder tree:

```bash
ROOT=$(colab drive mkdir project -p "$DRIVE_FOLDER" --json | jq -r '.folderId')
DATA=$(colab drive mkdir data -p "$ROOT" --json | jq -r '.folderId')
colab drive upload ./dataset.csv -p "$DATA" --json
```

Command failures emit `{"error":"..."}` with a non-zero exit code.

## Notes

- `runtime destroy` removes both the live assignment and the locally stored record, and gracefully shuts down the associated daemon.
- If Colab returns `412` or `503` during runtime creation, that is usually a backend-side quota or capacity issue rather than a local transport failure.
