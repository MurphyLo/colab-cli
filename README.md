# colab-cli

A terminal-first CLI for creating and using Google Colab runtimes outside the browser.

This project is a migration of the Colab runtime logic from the `colab-vscode` codebase into a standalone command-line tool. It supports:

- Google OAuth login
- Listing available Colab runtime options
- Creating and destroying runtimes
- Executing Python code on an active runtime via a background daemon
- Streaming outputs directly to the terminal
- Uploading and downloading files to/from the runtime filesystem
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
colab runtime create --accelerator L4 --shape highmem
colab runtime create --accelerator v6e-1 --shape highmem
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
| > 500 MiB | Drive | Not yet implemented (planned: Google Drive) |

For chunked uploads, chunks are uploaded to a temp directory on the runtime, then assembled via kernel execution. For chunked downloads, the file is split into chunks on the kernel, downloaded concurrently, then assembled locally.

## Runtime Naming and Shape Semantics

Two different semantics are in play:

- `runtime available` uses Colab UI-oriented naming such as `GPU H100`, `GPU L4`, `TPU v6e-1`
- `runtime list` shows the active assignments returned by the backend, including the backend machine shape

This matters for high-memory-only accelerators. For example, `L4`, `H100`, `G4`, `v6e-1`, and `v5e-1` are treated as `High-RAM` in CLI input semantics, but the backend may still report them as `Standard` in assignment listings.

Practical rule:

- Use `--shape highmem` or omit `--shape` for those accelerators
- Do not use `--shape standard` for them

## Proxy Usage

If you are behind a proxy, set `NODE_OPTIONS` so that Node.js honors proxy environment variables:

```bash
export NODE_OPTIONS=--use-env-proxy
export HTTPS_PROXY=http://127.0.0.1:7897

colab runtime available
```

Without `--use-env-proxy`, newer Node versions will detect the proxy environment variables but will not route traffic through them automatically.

## Environment Variables

The CLI has built-in OAuth defaults, but you can override them:

```bash
export COLAB_CLIENT_ID=...
export COLAB_CLIENT_SECRET=...
```

## Command Summary

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
```

## Notes

- The CLI uses a detached background daemon to maintain the WebSocket connection to the Colab kernel. The daemon handles keep-alive heartbeats and automatically refreshes runtime proxy tokens.
- `destroy` removes both the live assignment and the locally stored runtime record, and gracefully shuts down the associated daemon process.
- If Colab returns `412` or `503` during creation, that is usually a backend-side quota, capacity, or assignment issue rather than a local transport failure.
