# colab-cli

A terminal-first CLI for Google Colab — create runtimes, execute Python on GPUs/TPUs, and manage files, all from the command line. Many implementation patterns are adapted from [`colab-vscode`](https://github.com/googlecolab/colab-vscode) and [`jupyter-kernel-client`](https://github.com/googlecolab/jupyter-kernel-client).

This tool supports:

- Google OAuth login
- Listing available Colab runtime options
- Creating and destroying runtimes
- Executing Python code on an active runtime via a background daemon
- Interactive shell sessions with attach/detach, background mode, and raw input forwarding
- Interactive stdin support (`input()` / `getpass`) and Ctrl+C kernel interrupt
- Streaming outputs directly to the terminal (including automatic image file saving)
- Uploading and downloading files to/from the runtime filesystem
- Google Drive file management (upload/download/list/mkdir/delete/move)
- Automatic Drive mounting on runtimes (no browser required after one-time setup)
- Querying subscription tier and Colab Compute Unit (CCU) usage

## Requirements

- Node.js 18+
- A Google account with Colab access
- Network access to:
  - `https://colab.research.google.com`
  - `https://colab.pa.googleapis.com`
  - Google OAuth endpoints

## Install

### From npm (global)

```bash
npm install -g colab-cli
```

This makes the `colab` command available globally.

### From source (development)

```bash
npm install
npm run build
npm link
```

After `npm link`, the `colab` command points to your local build. Run `npm run build` (or keep `npm run dev` running) to pick up code changes — no need to re-link.

## Authentication

Sign in through the browser-based OAuth flow:

```bash
colab auth login
```

Check the current session:

```bash
colab auth status
```

Sign out:

```bash
colab auth logout
```

Auth state is stored at:

```text
~/.config/colab-cli/auth.json
```

## Runtime Workflow

List the runtime options available to the current account:

```bash
colab runtime available
```

List available runtime versions and their environment details:

```bash
colab runtime versions
```

Create a runtime by accelerator name, using Colab UI semantics:

```bash
colab runtime create --accelerator CPU
colab runtime create --accelerator T4 --shape standard
colab runtime create --accelerator L4 --shape high-ram
colab runtime create --accelerator v6e-1 --shape high-ram
```

Optionally pin to a specific runtime version (see `colab runtime versions` for available labels):

```bash
colab runtime create --accelerator T4 --runtime-version 2025.10
```

List active runtimes:

```bash
colab runtime list
```

Destroy a runtime:

```bash
colab runtime destroy --endpoint <endpoint>
```

Restart the kernel without destroying the VM:

```bash
colab runtime restart --endpoint <endpoint>
```

Runtime state is stored at:

```text
~/.config/colab-cli/servers.json
```

## Usage and Subscription Info

Show the current account's subscription tier and Colab Compute Unit (CCU) consumption:

```bash
colab usage
```

Output depends on the subscription tier:

- **Free accounts**: shows free CCU quota remaining (in CCU, converted from milli-CCU) and the next quota refill time.
- **Pro / Pro+ accounts**: shows the paid CCU balance instead.

Both tiers always show the current hourly consumption rate based on all assigned VMs.

## Execute Code

Code execution is handled by a background daemon process that maintains a persistent WebSocket connection to the Colab kernel. This allows for fast, repeated executions while preserving Python state across calls.

Run inline Python:

```bash
colab exec "
x = 6 * 7
print('value:', x)
for i in range(3):
    print('row', i)
"
```

Run a file:

```bash
colab exec -f script.py
```

Save image outputs to a specific directory:

```bash
colab exec -o ./plots "import matplotlib.pyplot as plt; plt.plot([1,2,3]); plt.show()"
# => [saved image/png → ./plots/exec1-output-1.png]
```

If `--output-dir` is not specified, images are saved automatically to `~/.config/colab-cli/outputs/<serverId>/`. File names follow the pattern `exec<id>-output-<n>.<ext>` for cross-execution isolation. Supported formats: PNG, JPEG, GIF, SVG.

If multiple runtimes exist, target one explicitly:

```bash
colab exec -e <endpoint> "import torch; print(torch.cuda.is_available())"
```

By default, `exec` uses the most recently created runtime.

### Interactive Input

Code that calls Python's `input()` or `getpass.getpass()` works transparently --
the prompt is forwarded to the terminal, user input is sent back to the kernel,
and execution continues:

```bash
colab exec "name = input('Name: '); print(f'Hello {name}')"
# Name: Alice         ← you type here
# Hello Alice
```

Password prompts (`getpass`) suppress character echo automatically.

### Ctrl+C (Interrupt)

Pressing Ctrl+C during execution sends an interrupt signal to the Colab kernel
(equivalent to the stop button in Colab UI). The kernel raises
`KeyboardInterrupt`, the traceback is rendered, and the CLI exits normally:

```bash
colab exec "import time; time.sleep(9999)"
# ^C
# KeyboardInterrupt                         Traceback (most recent call last)
# ...
```

A second Ctrl+C force-exits the CLI immediately.

### Error Handling

If executed code raises a Python exception, the traceback is rendered and
`colab exec` exits with a non-zero status code.

### Drive Mounting

If executed code triggers `drive.mount('/content/drive')` or another ephemeral
Google credential request, the foreground CLI session will prompt for consent,
open the browser-based OAuth flow, and continue once authorization is complete.

For background executions, the daemon stores the OAuth URL in the execution
state. `exec attach --no-wait`, `exec attach --tail`, and streaming
`exec attach` all surface that URL, and the daemon retries credential
propagation automatically every 5 seconds after the browser flow completes.

If automatic Drive mounting is configured (see below), `drive.mount()` will
detect the pre-mounted filesystem and return immediately without any auth prompt.

### Background Execution

Run code in the background with `-b` / `--background` — the CLI returns immediately with an exec ID while the kernel continues executing:

```bash
colab exec -b "import time; [print(i) or time.sleep(1) for i in range(60)]"
# 1     ← exec ID printed to stdout
```

List all executions:

```bash
colab exec list
```

Each execution shows one of six statuses: `running` (in progress), `done`
(completed successfully), `error` (Python exception or interrupt), `crashed`
(daemon-level failure), `input` (waiting for `input()` response), or `auth`
(waiting for browser-based authorization). The `ELAPSED` column shows the
execution duration (e.g., `5s`, `2m15s`, `1h30m`).

View buffered output without blocking:

```bash
colab exec attach 1 --no-wait
colab exec attach 1 --tail 20        # last 20 outputs only (implies --no-wait)
```

If the execution is paused on browser auth, these snapshot commands print the
stored OAuth URL and exit immediately.

Attach for live streaming (blocks until execution finishes, like foreground exec):

```bash
colab exec attach 1
```

If the execution is currently waiting on browser auth, streaming attach also
prints the stored OAuth URL before continuing to wait for live output.

Send stdin to a running execution:

```bash
colab exec send 1 --stdin "yes"
```

Interrupt a running execution:

```bash
colab exec send 1 --interrupt
```

Clear execution history:

```bash
colab exec clear              # clear all completed executions
colab exec clear 3            # clear a specific execution by ID
```

Running or input-waiting executions are preserved; only completed (`done`, `error`, `crashed`) entries are removed.

Background execution is designed for AI tool use — an AI assistant can start a long-running job, do other work, and check back for output later. All executions (foreground and background) are tracked by the daemon and visible via `exec list`.

Note: The Jupyter kernel is serial — only one execution runs at a time. Starting a new exec while another is running will be rejected.

## Interactive Shell

Open an interactive terminal on the runtime:

```bash
colab shell
```

Foreground shell sessions use your current TTY directly. Press `Ctrl+\` to
detach locally while leaving the remote shell running in the daemon.

Start a detached shell and print its shell ID:

```bash
colab shell -b
# 1     ← shell ID printed to stdout
```

List active shell sessions:

```bash
colab shell list
```

Inspect buffered output without blocking:

```bash
colab shell attach 1 --no-wait
colab shell attach 1 --tail 4096   # last 4096 bytes only
```

Re-attach for live streaming:

```bash
colab shell attach 1
```

Send raw data or control signals to a detached shell:

```bash
colab shell send 1 --data "ls -la\\n"
colab shell send 1 --signal INT    # Ctrl+C
colab shell send 1 --signal EOF    # Ctrl+D
```

If another client attaches to the same shell, the previous client is detached
and notified. Closed shell sessions remain queryable for a short grace period
so `shell list` and snapshot attach can still inspect the final buffered output.

## Port Forwarding

Forward a port on the runtime to your local machine so you can reach web services (Gradio, Streamlit, TensorBoard, Flask, …) through a local bind address. The forward is an L7 HTTP/WebSocket reverse proxy backed by Colab's edge infrastructure — no ngrok, no share link, no runtime-side agent.

Traffic is tunneled through `https://<PORT>-<endpoint>.colab.dev` with a signed per-port proxy token (automatically refreshed before expiry). Each forward runs in the daemon; the CLI exits as soon as the listener is bound.

Start a service in the runtime, then:

```bash
# same port on both sides (binds 127.0.0.1 by default)
colab port-forward create 7860

# custom local port (when 7860 is already in use locally)
colab port-forward create 18080:7860

# explicit bind host, local port, and remote port
colab port-forward create 0.0.0.0:18080:7860

# list active forwards
colab port-forward list

# close by ID, or close all
colab port-forward close 1
colab port-forward close --all
```

`pf` is a shorter alias for `port-forward`. The `create` spec accepts `REMOTE`, `LOCAL:REMOTE`, or `HOST:LOCAL:REMOTE`; the 1-part and 2-part forms default the bind host to `127.0.0.1`.

Forwards live as long as the daemon. If the runtime is destroyed (or the daemon is killed) all forwards are cleared and must be recreated.

**Scope**: HTTP and WebSocket only. Raw TCP protocols (PostgreSQL wire, Redis RESP, SSH, gRPC-over-HTTP2, etc.) aren't supported — for those, use SSH-style tunnels or a VPN. Typical ML/data-app uses (Gradio, Streamlit, Flask/FastAPI, TensorBoard, notebooks, dev servers) all work.

## File Transfer

Upload and download files between the local filesystem and the runtime's `/content` directory. Files are transferred via the Jupyter Contents API with automatic chunked transfer for large files.

Upload a file:

```bash
colab fs upload ./data.csv
colab fs upload ./model.bin -r content/models/model.bin
```

Download a file:

```bash
colab fs download content/results.json
colab fs download content/output.bin -o ./local-output.bin
```

Transfer strategy is chosen automatically based on file size:

| File size | Strategy | Description |
|-----------|----------|-------------|
| ≤ 20 MiB | Direct | Single REST request |
| 20–500 MiB | Chunked | Split into 20 MiB chunks, transferred concurrently (up to 25 parallel) |
| > 500 MiB | Drive | Use `colab drive upload` / `colab drive download` (see below) |

For chunked uploads, chunks are uploaded to a temp directory on the runtime, then assembled via kernel execution. For chunked downloads, the file is split into chunks on the kernel, downloaded concurrently, then assembled locally.

## Google Drive

Manage files directly on Google Drive — useful for large files that can be accessed from Colab runtimes via Drive mount.

### Drive Authentication

Drive uses a **separate OAuth flow** from the Colab login. Sign in explicitly before using Drive commands:

```bash
colab drive login
```

Check status or sign out:

```bash
colab drive status
colab drive logout
```

Drive credentials are stored at `~/.config/colab-cli/drive-auth.json`.

### Commands

```bash
colab drive login                             # Authorize Google Drive access
colab drive logout                            # Remove stored credentials (revokes server-side)
colab drive status                            # Show authorization status
colab drive list [folder-id]                  # List files (default: root)
colab drive upload <local-path> [-p <id>]     # Upload file (resumable for >5 MiB)
colab drive download <file-id> [-o <path>]    # Download file
colab drive mkdir <name> [-p <id>]            # Create folder
colab drive delete <file-id> [--permanent]    # Delete (default: trash)
colab drive move <item-id> --to <folder-id>   # Move file or folder to folder
```

All references to Drive items use **folder/file IDs** (not names), because Google Drive allows duplicate names within the same folder. Use `list` to find IDs.

Upload features:
- **Resumable**: Files >5 MiB use Google's resumable upload protocol (8 MiB chunks). Interrupted uploads can be resumed by re-running the same command.
- **MD5 dedup**: Skips upload if an identical file (by MD5) already exists in the target folder.

### Shared with me

Files and folders other people have shared with you are reachable as a **virtual folder** named `Shared with me` at the bottom of the root listing. Its sentinel ID is `shared`:

```bash
colab drive list                  # My Drive root; "Shared with me/" appears at the end
colab drive list shared           # browse items shared with you
```

Inside the shared view, every entry is a real Drive file with a real ID, so the existing commands work transparently:

```bash
colab drive download <file-id>            # download a shared file
colab drive move <file-id> --to <folder>  # see note below
```

Because Shared with me items have no parent in your own namespace, a true "move" is impossible for files you don't own. In that case `colab drive move` **automatically falls back to a copy** into the destination folder, prints a clear note explaining what happened, and the new copy is owned by you. Files you do own move normally. In `--json` mode the result includes `"mode": "moved"` or `"mode": "copied"` (with a `newFileId`) so scripts can distinguish the two outcomes.

`colab drive delete` is rejected for shared files you don't own (only the owner can delete them); use the Drive web UI if you want to remove your access.

### Custom OAuth Credentials

By default, Drive commands use shared OAuth credentials. If you hit quota limits, create your own GCP OAuth client:

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the **Google Drive API**
3. Create an **OAuth 2.0 Client ID** (Desktop app)
4. Publish the app (OAuth consent screen → Production)
5. Set environment variables:

```bash
export COLAB_DRIVE_CLIENT_ID=your-client-id.apps.googleusercontent.com
export COLAB_DRIVE_CLIENT_SECRET=your-client-secret
```

After changing credentials, run `colab drive login` to re-authorize.

## Automatic Drive Mounting

Mount Google Drive on a runtime without the browser-based consent flow that `drive.mount()` normally requires for each new runtime.

### Setup (one-time)

Authorize once (opens browser):

```bash
colab drive-mount login
```

Credentials are stored at `~/.config/colab-cli/drive-mount-auth.json`.

### Usage

After the one-time setup, mount Drive on any runtime — no browser needed:

```bash
colab drive-mount                        # Mount on the latest runtime
colab drive-mount -e <endpoint>          # Mount on a specific runtime
```

Drive is mounted at `/content/drive`. Subsequent calls to `drive.mount('/content/drive')` in Python code will detect the existing mount and return immediately.

Check status or remove credentials:

```bash
colab drive-mount status
colab drive-mount logout
```

## Runtime Naming and Shape Semantics

All three runtime subcommands (`available`, `create`, `list`) use consistent Colab UI-oriented shape semantics. High-memory-only accelerators (`H100`, `G4`, `L4`, `v6e-1`, `v5e-1`) are always displayed as `High-RAM`, regardless of the raw backend value.

Practical rule:

- Use `--shape high-ram` or omit `--shape` for those accelerators
- Do not use `--shape standard` for them

## Proxy Usage

If you are behind a proxy, set `NODE_OPTIONS` so that Node.js honors proxy environment variables:

```bash
export NODE_OPTIONS=--use-env-proxy
export HTTPS_PROXY=http://127.0.0.1:7897

colab runtime available
```

Without `--use-env-proxy`, newer Node versions will detect the proxy environment variables but will not route traffic through them automatically.

## JSON Output (Scripting)

Most commands support a global `--json` flag that keeps stdout machine-readable for shell scripts and automation pipelines (`exec` and `shell` are excluded — they use interactive terminal-style output).

Human-facing progress and consent prompts are routed to stderr. Login commands (`auth login`, `drive login`, `drive-mount login`) in `--json` mode are non-blocking: they emit an `auth_required` event with the OAuth URL and timeout, then exit immediately while a background daemon waits for the browser callback. Poll the corresponding `status --json` command to confirm login completion.

```bash
# Interactive (human-readable spinner on stderr)
colab drive mkdir models -p "$PARENT_ID"

# Scripting (structured JSON on stdout)
colab drive mkdir models -p "$PARENT_ID" --json
# => {"command":"drive.mkdir","name":"models","folderId":"1Abc...","parentId":"1Xyz..."}

# OAuth login in JSON mode (returns immediately)
colab auth login --json
# => {"event":"auth_required","authType":"colab","url":"https://accounts.google.com/...","timeoutSeconds":120}
```

Example: building a nested Drive folder tree in a script:

```bash
ROOT=$(colab drive mkdir project -p "$DRIVE_FOLDER" --json | jq -r '.folderId')
DATA=$(colab drive mkdir data -p "$ROOT" --json | jq -r '.folderId')
colab drive upload ./dataset.csv -p "$DATA" --json
```

Successful commands emit one or more JSON lines. The final success object includes a `command` field plus command-specific data fields. Command-level failures emit a JSON error object and exit non-zero. If interactive consent is required but stdin is non-interactive, the error is:

```json
{"error":"consent_required","authType":"dfs_ephemeral","url":"https://accounts.google.com/..."}
```

## Environment Variables

The CLI has built-in OAuth defaults, but you can override them:

```bash
export COLAB_CLIENT_ID=...              # Colab OAuth client
export COLAB_CLIENT_SECRET=...
export COLAB_DRIVE_CLIENT_ID=...        # Drive OAuth client (see Google Drive section)
export COLAB_DRIVE_CLIENT_SECRET=...
```

## Command Summary

Most commands accept the global `--json` flag for machine-readable output (`exec` and `shell` excluded).

```text
colab auth login
colab auth status
colab auth logout
colab runtime available
colab runtime versions
colab runtime create --accelerator <name> [--shape <shape>] [-v <version>]
colab runtime list
colab runtime destroy [--endpoint <endpoint>]
colab runtime restart [--endpoint <endpoint>]
colab usage
colab exec [code] [-f <file>] [-e <endpoint>] [-o <output-dir>]
colab shell [-e <endpoint>] [-b]
colab shell attach <id> [-e <endpoint>] [--no-wait] [--tail <bytes>]
colab shell list [-e <endpoint>]
colab shell send <id> [-e <endpoint>] [--data <data> | --signal <signal>]
colab port-forward create <spec> [-e <endpoint>]
colab port-forward list [-e <endpoint>]
colab port-forward close [id] [-e <endpoint>] [--all]
colab fs upload <local-path> [-r <remote-path>] [-e <endpoint>]
colab fs download <remote-path> [-o <local-path>] [-e <endpoint>]
colab drive login
colab drive logout
colab drive status
colab drive list [folder-id]
colab drive upload <local-path> [-p <folder-id>]
colab drive download <file-id> [-o <path>]
colab drive mkdir <name> [-p <folder-id>]
colab drive delete <file-id> [--permanent]
colab drive move <item-id> --to <folder-id>
colab drive-mount
colab drive-mount login
colab drive-mount logout
colab drive-mount status
```

## Notes

- The CLI uses a detached background daemon to maintain the WebSocket connection to the Colab kernel. The daemon handles keep-alive heartbeats and automatically refreshes runtime proxy tokens.
- `destroy` removes both the live assignment and the locally stored runtime record, and gracefully shuts down the associated daemon process.
- If Colab returns `412` or `503` during creation, that is usually a backend-side quota, capacity, or assignment issue rather than a local transport failure.
