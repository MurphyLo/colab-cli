# colab-cli

A terminal-first CLI for creating and using Google Colab runtimes outside the browser.

This project is a migration of the Colab runtime logic from the `colab-vscode` codebase into a standalone command-line tool. It supports:

- Google OAuth login
- Listing available Colab runtime options
- Creating and destroying runtimes
- Executing Python code on an active runtime via a background daemon
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

Run in batch mode (collects all output and prints once finished, rather than streaming):

```bash
colab exec -b "print('hello')"
```

Save image outputs to a specific directory:

```bash
colab exec -o ./plots "import matplotlib.pyplot as plt; plt.plot([1,2,3]); plt.show()"
# => [saved image/png → ./plots/output-1.png]
```

If `--output-dir` is not specified, images are saved automatically to `~/.config/colab-cli/outputs/<timestamp>/` (a new timestamped subdirectory per execution, so successive runs never overwrite each other). Supported formats: PNG, JPEG, GIF, SVG.

In `--json` mode, image data in the output is replaced with the saved file path:

```json
{"command":"exec","outputs":[{"type":"display_data","data":{"image/png":"/path/to/output-1.png"}}]}
```

If multiple runtimes exist, target one explicitly:

```bash
colab exec -e <endpoint> "import torch; print(torch.cuda.is_available())"
```

By default, `exec` uses the most recently created runtime.

If executed code raises a Python exception, the traceback is rendered and
`colab exec` exits with a non-zero status code. In `--json` mode, the final
result remains an `{"command":"exec",...}` object and includes `error: true`
rather than switching to the generic top-level JSON error shape.

If executed code triggers `drive.mount('/content/drive')` or another ephemeral
Google credential request, the foreground CLI session will prompt for consent,
open the browser-based OAuth flow, and continue once authorization is complete.

If automatic Drive mounting is configured (see below), `drive.mount()` will
detect the pre-mounted filesystem and return immediately without any auth prompt.

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

All commands support a global `--json` flag that keeps stdout machine-readable for shell scripts and automation pipelines.

Human-facing progress and consent prompts are routed to stderr. Commands that need a browser-based OAuth step may emit an `auth_required` JSON event before the final command result:

```bash
# Interactive (human-readable spinner on stderr)
colab drive mkdir models -p "$PARENT_ID"

# Scripting (structured JSON on stdout)
colab drive mkdir models -p "$PARENT_ID" --json
# => {"command":"drive.mkdir","name":"models","folderId":"1Abc...","parentId":"1Xyz..."}

# OAuth-driven flow in JSON mode
colab auth login --json
# => {"event":"auth_required","context":"Google sign-in","url":"https://accounts.google.com/..."}
# => {"command":"auth.login","name":"Jane Doe","email":"jane@example.com"}
```

Example: building a nested Drive folder tree in a script:

```bash
ROOT=$(colab drive mkdir project -p "$DRIVE_FOLDER" --json | jq -r '.folderId')
DATA=$(colab drive mkdir data -p "$ROOT" --json | jq -r '.folderId')
colab drive upload ./dataset.csv -p "$DATA" --json
```

Successful commands emit one or more JSON lines. The final success object includes a `command` field plus command-specific data fields. Command-level failures emit a JSON error object and exit non-zero. `colab exec` also exits non-zero when kernel output contains a Python error; in that case the final JSON object is still `{"command":"exec",...}` and includes `error: true`. If interactive consent is required but stdin is non-interactive, the error is:

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

All commands accept the global `--json` flag for machine-readable output.

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
colab exec [code] [-f <file>] [-e <endpoint>] [-b|--batch] [-o <output-dir>]
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
