# colab-cli

A terminal-first CLI for creating and using Google Colab runtimes outside the browser.

This project is a migration of the Colab runtime logic from the `colab-vscode` codebase into a standalone command-line tool. It supports:

- Google OAuth login
- Listing available Colab runtime options
- Creating and destroying runtimes
- Executing Python code on an active runtime via a background daemon
- Streaming outputs directly to the terminal
- Uploading and downloading files to/from the runtime filesystem
- Google Drive file management (upload/download/list/mkdir/delete/move)
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

Create a runtime by accelerator name, using Colab UI semantics:

```bash
colab runtime create --accelerator CPU
colab runtime create --accelerator T4 --shape standard
colab runtime create --accelerator L4 --shape high-ram
colab runtime create --accelerator v6e-1 --shape high-ram
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

If multiple runtimes exist, target one explicitly:

```bash
colab exec -e <endpoint> "import torch; print(torch.cuda.is_available())"
```

By default, `exec` uses the most recently created runtime.

If executed code triggers `drive.mount('/content/drive')` or another ephemeral
Google credential request, the foreground CLI session will prompt for consent,
open the browser-based OAuth flow, and continue once authorization is complete.

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

Drive uses a **separate OAuth flow** from the Colab login. The first time you run any `drive` subcommand, a browser-based authorization prompt will appear. Drive credentials are stored independently at `~/.config/colab-cli/drive-auth.json`.

### Commands

```bash
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

After changing credentials, run any `drive` command to re-authorize.

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

All commands support a global `--json` flag that writes structured JSON to stdout, making output reliable for shell scripts and automation pipelines.

```bash
# Interactive (human-readable spinner on stderr)
colab drive mkdir models -p "$PARENT_ID"

# Scripting (structured JSON on stdout)
colab drive mkdir models -p "$PARENT_ID" --json
# => {"command":"drive.mkdir","name":"models","folderId":"1Abc...","parentId":"1Xyz..."}
```

Example: building a nested Drive folder tree in a script:

```bash
ROOT=$(colab drive mkdir project -p "$DRIVE_FOLDER" --json | jq -r '.folderId')
DATA=$(colab drive mkdir data -p "$ROOT" --json | jq -r '.folderId')
colab drive upload ./dataset.csv -p "$DATA" --json
```

Every command emits a JSON object with a `command` field identifying the command, plus command-specific data fields. On error, the output is `{"error":"message"}` with a non-zero exit code.

## Environment Variables

The CLI has built-in OAuth defaults, but you can override them:

```bash
export COLAB_CLIENT_ID=...          # Colab OAuth client
export COLAB_CLIENT_SECRET=...
export COLAB_DRIVE_CLIENT_ID=...    # Drive OAuth client (see Google Drive section)
export COLAB_DRIVE_CLIENT_SECRET=...
```

## Command Summary

All commands accept the global `--json` flag for machine-readable output.

```text
colab auth login
colab auth status
colab auth logout
colab runtime available
colab runtime create --accelerator <name> [--shape <shape>]
colab runtime list
colab runtime destroy [--endpoint <endpoint>]
colab runtime restart [--endpoint <endpoint>]
colab usage
colab exec [code] [-f <file>] [-e <endpoint>] [-b|--batch]
colab fs upload <local-path> [-r <remote-path>] [-e <endpoint>]
colab fs download <remote-path> [-o <local-path>] [-e <endpoint>]
colab drive list [folder-id]
colab drive upload <local-path> [-p <folder-id>]
colab drive download <file-id> [-o <path>]
colab drive mkdir <name> [-p <folder-id>]
colab drive delete <file-id> [--permanent]
colab drive move <item-id> --to <folder-id>
```

## Notes

- The CLI uses a detached background daemon to maintain the WebSocket connection to the Colab kernel. The daemon handles keep-alive heartbeats and automatically refreshes runtime proxy tokens.
- `destroy` removes both the live assignment and the locally stored runtime record, and gracefully shuts down the associated daemon process.
- If Colab returns `412` or `503` during creation, that is usually a backend-side quota, capacity, or assignment issue rather than a local transport failure.
