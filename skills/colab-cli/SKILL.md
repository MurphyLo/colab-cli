---
name: colab-cli
description: "Use this skill whenever the user wants to operate Google Colab from the terminal: authenticate, inspect available runtimes, create or destroy a runtime, restart a kernel, check CCU usage, execute Python remotely, upload or download files to a Colab runtime, manage files in Google Drive through `colab drive`, or mount Drive on a runtime via `colab drive-mount`. Prefer this skill even if the user does not mention `colab-cli` explicitly but asks to use a Colab GPU or TPU, run code on Colab from a shell, move files to `/content`, move large files through Drive, mount Drive automatically, or troubleshoot Colab auth, Drive auth, quota, proxy, or runtime lifecycle issues."
metadata:
  short-description: Use the `colab` CLI for Colab auth, runtime, exec, fs, usage, Drive, and Drive mount tasks
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
   - Use `colab runtime`, `colab exec`, and `colab fs` for runtime lifecycle, remote execution, and `/content` file transfer.
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

All commands accept a global `--json` flag. When set, spinners are suppressed and the result is written as a single JSON object to stdout. Use this for scripting and automation.

```bash
# Extract a folder ID reliably
FOLDER_ID=$(colab drive mkdir models -p "$PARENT" --json | jq -r '.folderId')

# Extract a runtime endpoint
ENDPOINT=$(colab runtime create --accelerator T4 --shape standard --json | jq -r '.endpoint')
```

Every JSON object includes a `command` field (e.g. `"drive.mkdir"`, `"runtime.create"`). Command-level failures return `{"error":"..."}` with a non-zero exit code. `colab exec --json` has one extra case: if the kernel emits a Python error, the final object is still `{"command":"exec",...}` and includes `error: true`, and the command exits non-zero.

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
colab runtime create --accelerator CPU
colab runtime create --accelerator T4 --shape standard
colab runtime create --accelerator L4 --shape high-ram
colab runtime list
colab runtime restart --endpoint <endpoint>
colab runtime destroy --endpoint <endpoint>
```

Use `available` before creation when the user wants to know what their account can launch. Use `list` whenever endpoint selection matters.

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
colab exec -f script.py
colab exec -b "print('batch mode')"
colab exec -e <endpoint> "import torch; print(torch.cuda.is_available())"
```

- Use inline code for short snippets.
- Use `-f` for multi-line scripts or when shell quoting would be fragile.
- Use `-b` when the user wants final output only rather than streamed logs.
- If the executed Python code raises an exception, `colab exec` exits non-zero. In `--json` mode, treat `error: true` on the final `command: "exec"` object as an execution failure signal.
- If the code mounts Google Drive or requests an ephemeral Google credential, the foreground CLI may open a consent flow and continue after approval. If `colab drive-mount` was run beforehand, `drive.mount()` detects the existing mount and skips auth entirely.

### Runtime Filesystem Transfer

```bash
colab fs upload ./data.csv
colab fs upload ./model.bin -r content/models/model.bin
colab fs download content/results.json
colab fs download content/output.bin -o ./local-output.bin
```

- Use `colab fs` for files moving directly between local disk and the runtime filesystem, usually under `content/...`.
- Transfers up to 500 MiB are handled directly or via chunking.
- If the file is larger than 500 MiB, or the user wants the asset to live in Drive instead of `/content`, switch to `colab drive`.

### Google Drive

```bash
colab drive list
colab drive list <folder-id>
colab drive upload ./dataset.zip -p <folder-id>
colab drive download <file-id> -o ./dataset.zip
colab drive mkdir "checkpoints" -p <folder-id>
colab drive move <item-id> --to <folder-id>
colab drive delete <file-id>
colab drive delete <file-id> --permanent
```

- `colab drive` has its own OAuth session and does not rely on `colab auth login`.
- Drive commands use file IDs and folder IDs, not human-readable names or path strings. If the user only knows a name, list the folder first to find the ID.
- `drive upload` is resumable for large files and can continue after interruption by re-running the same command.
- For large assets, durable storage, or workflows that rely on `drive.mount('/content/drive')`, prefer `colab drive` over `colab fs`.

### Automatic Drive Mounting

```bash
colab drive-mount login                  # One-time: authorize (opens browser)
colab drive-mount                        # Mount Drive on the latest runtime
colab drive-mount -e <endpoint>          # Mount on a specific runtime
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
- If a Drive command fails because the input looks like a filename instead of an ID, run `colab drive list` first and use the actual file or folder ID.
- If a script needs to capture command output (IDs, endpoints, paths), always use `--json`. Without it, all human-readable output goes to stderr via the spinner and `$(...)` will capture nothing.
- Drive quota or OAuth client issues can be addressed by setting `COLAB_DRIVE_CLIENT_ID` and `COLAB_DRIVE_CLIENT_SECRET`, then re-running a Drive command to re-authorize.
- For exact flag syntax or new subcommands, re-check `colab --help` or the relevant subcommand help instead of guessing.

## Response Style

- State which runtime endpoint you are using when the command is endpoint-sensitive.
- State clearly whether you are operating on the runtime filesystem or Google Drive.
- Quote code snippets and file paths conservatively to avoid shell parsing mistakes.
- Summarize outcomes in terms the user cares about: auth status, selected accelerator, endpoint, execution result, uploaded file, downloaded path, Drive file ID, Drive folder ID, or quota state.
- Keep the workflow terminal-first.
