# colab-cli

A terminal-first CLI for creating and using Google Colab runtimes outside the browser.

This project is a migration of the Colab runtime logic from the `colab-vscode` codebase into a standalone command-line tool. It supports:

- Google OAuth login
- Listing available Colab runtime options
- Creating and destroying runtimes
- Executing Python code on an active runtime via a background daemon
- Streaming outputs directly to the terminal

## Requirements

- Node.js 18+
- A Google account with Colab access
- Network access to:
  - `https://colab.research.google.com`
  - `https://colab.pa.googleapis.com`
  - Google OAuth endpoints

## Install

```bash
npm install
npm run build
```

Run the built CLI with:

```bash
node dist/index.js --help
```

If you want Node to honor `HTTP_PROXY` / `HTTPS_PROXY`, use:

```bash
node --use-env-proxy dist/index.js --help
```

Or use:

```bash
npm start -- --help
```

## Authentication

Sign in through the browser-based OAuth flow:

```bash
node --use-env-proxy dist/index.js auth login
```

Check the current session:

```bash
node --use-env-proxy dist/index.js auth status
```

Sign out:

```bash
node --use-env-proxy dist/index.js auth logout
```

Auth state is stored at:

```text
~/.config/colab-cli/auth.json
```

## Runtime Workflow

List the runtime options available to the current account:

```bash
node --use-env-proxy dist/index.js runtime available
```

Create a runtime by accelerator name, using Colab UI semantics:

```bash
node --use-env-proxy dist/index.js runtime create --accelerator CPU
node --use-env-proxy dist/index.js runtime create --accelerator T4 --shape standard
node --use-env-proxy dist/index.js runtime create --accelerator L4 --shape highmem
node --use-env-proxy dist/index.js runtime create --accelerator v6e-1 --shape highmem
```

List active runtimes:

```bash
node --use-env-proxy dist/index.js runtime list
```

Destroy a runtime:

```bash
node --use-env-proxy dist/index.js runtime destroy --endpoint <endpoint>
```

Restart the kernel without destroying the VM:

```bash
node --use-env-proxy dist/index.js runtime restart --endpoint <endpoint>
```

Runtime state is stored at:

```text
~/.config/colab-cli/servers.json
```

## Execute Code

Code execution is handled by a background daemon process that maintains a persistent WebSocket connection to the Colab kernel. This allows for fast, repeated executions while preserving Python state across calls.

Run inline Python:

```bash
node --use-env-proxy dist/index.js exec "
x = 6 * 7
print('value:', x)
for i in range(3):
    print('row', i)
"
```

Run a file:

```bash
node --use-env-proxy dist/index.js exec -f script.py
```

Run in batch mode (collects all output and prints once finished, rather than streaming):

```bash
node --use-env-proxy dist/index.js exec -b "print('hello')"
```

If multiple runtimes exist, target one explicitly:

```bash
node --use-env-proxy dist/index.js exec -e <endpoint> "import torch; print(torch.cuda.is_available())"
```

By default, `exec` uses the most recently created runtime.

## Runtime Naming and Shape Semantics

Two different semantics are in play:

- `runtime available` uses Colab UI-oriented naming such as `GPU H100`, `GPU L4`, `TPU v6e-1`
- `runtime list` shows the active assignments returned by the backend, including the backend machine shape

This matters for high-memory-only accelerators. For example, `L4`, `H100`, `G4`, `v6e-1`, and `v5e-1` are treated as `High-RAM` in CLI input semantics, but the backend may still report them as `Standard` in assignment listings.

Practical rule:

- Use `--shape highmem` or omit `--shape` for those accelerators
- Do not use `--shape standard` for them

## Proxy Usage

When running behind a local proxy:

```bash
HTTPS_PROXY=http://127.0.0.1:7897 \
HTTP_PROXY=http://127.0.0.1:7897 \
ALL_PROXY=http://127.0.0.1:7897 \
node --use-env-proxy dist/index.js runtime available
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
auth login
auth status
auth logout
runtime available
runtime create --accelerator <name> [--shape <shape>]
runtime list
runtime destroy [--endpoint <endpoint>]
runtime restart [--endpoint <endpoint>]
exec [code] [-f <file>] [-e <endpoint>] [-b|--batch]
```

## Notes

- The CLI uses a detached background daemon to maintain the WebSocket connection to the Colab kernel. The daemon handles keep-alive heartbeats and automatically refreshes runtime proxy tokens.
- `destroy` removes both the live assignment and the locally stored runtime record, and gracefully shuts down the associated daemon process.
- If Colab returns `412` or `503` during creation, that is usually a backend-side quota, capacity, or assignment issue rather than a local transport failure.
