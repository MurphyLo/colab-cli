# colab-cli 开发文档

> 本文档记录 colab-cli 的技术细节，服务于后续开发与调试。
> **请在开发和 debug 过程中持续更新本文档**——修复 bug 时补充踩坑记录，新增功能时更新架构说明，发现协议细节时补充到对应章节。

---

## 1. 项目概览

colab-cli 是一个终端工具，无需 VS Code 或 notebook UI，直接通过命令行与 Google Colab GPU runtime 交互。

核心能力：OAuth 登录 → 创建/销毁 runtime → 通过后台守护进程维持 WebSocket 长连接 → 执行 Python 代码并流式输出结果 → 文件传输（runtime 文件系统 + Google Drive）→ 自动 Drive 挂载（免浏览器）。

### 技术栈

| 项 | 选型 | 说明 |
|---|---|---|
| 语言 | TypeScript 5.4+ | strict mode |
| 模块 | ESM (`"type": "module"`) | 所有内部 import 必须带 `.js` 后缀 |
| 运行时 | Node.js ≥ 22 | 使用原生 `fetch`、`crypto.randomUUID`、`--use-env-proxy` |
| 包管理 | npm | `package.json` 在 `/colab-cli/` |

### 目录结构

```
colab-cli/
├── src/
│   ├── index.ts                     # CLI 入口，commander 定义
│   ├── config.ts                    # 域名、OAuth 凭据、文件路径
│   │
│   ├── daemon/                      # 后台守护进程（持久 WebSocket 连接）
│   │   ├── server.ts                # 守护进程入口（独立 Node 进程）
│   │   ├── client.ts                # DaemonClient：CLI 命令通过它与守护进程通信
│   │   ├── lifecycle.ts             # 守护进程生命周期：start/stop/isDaemonRunning
│   │   ├── protocol.ts             # NDJSON IPC 消息类型定义
│   │   ├── execution-store.ts      # 执行历史管理（内存缓存 + NDJSON 持久化）
│   │   └── image-saver.ts          # 图像输出持久化：将 display_data/execute_result 中的图像 MIME 写入磁盘
│   │
│   ├── colab/                       # Colab REST API 层
│   │   ├── api.ts                   # Zod schema + 类型定义
│   │   ├── client.ts                # ColabClient：assign/unassign/refresh/keepalive
│   │   └── headers.ts               # HTTP header 常量
│   │
│   ├── auth/                        # OAuth2 认证
│   │   ├── auth-manager.ts          # 令牌管理（刷新、存储、登录/登出）
│   │   ├── background-auth.ts       # --json 模式后台 OAuth（spawn 守护进程等待回调，父进程立即退出）
│   │   ├── loopback-flow.ts         # 本地回环服务器 OAuth 流程
│   │   ├── loopback-server.ts       # HTTP server 封装
│   │   ├── storage.ts               # 文件存储 (~/.config/colab-cli/auth.json)
│   │   └── ephemeral.ts             # 运行时临时授权（Drive 挂载等）
│   │
│   ├── jupyter/
│   │   ├── contents-client.ts       # Jupyter Contents API REST client（手写，绕过生成代码的路径编码问题）
│   │   ├── client/
│   │   │   ├── generated/           # OpenAPI 生成的 Jupyter REST client（复制自 colab-vscode）
│   │   │   └── index.ts             # ProxiedJupyterClient 封装
│   │   └── kernel-connection.ts     # WebSocket 内核连接 + Jupyter 线协议
│   │
│   ├── terminal/                    # 交互式终端（shell）
│   │   ├── terminal-connection.ts   # WebSocket 连接 /colab/tty（移植自 colab-vscode）
│   │   └── terminal-buffer.ts       # 有界环形缓冲区（attach 回放用）
│   │
│   ├── runtime/
│   │   ├── runtime-manager.ts       # 生命周期管理（create/destroy/list + 守护进程调度）
│   │   ├── keep-alive.ts            # 5 分钟心跳（由守护进程运行）
│   │   ├── connection-refresher.ts  # 过期前 5 分钟刷新代理令牌（由守护进程运行）
│   │   └── storage.ts               # 文件存储 (~/.config/colab-cli/servers.json)
│   │
│   ├── transfer/                    # 文件传输引擎
│   │   ├── common.ts               # 共享：ConnectionProvider、常量、runPool、路径工具
│   │   ├── upload.ts               # 上传逻辑（直接 / 分块并发 + 内核拼装）
│   │   └── download.ts             # 下载逻辑（直接 / 分块并发 + 内核切分）
│   │
│   ├── drive/                       # Google Drive 管理
│   │   ├── auth.ts                  # DriveAuthManager：独立 OAuth 流程（rclone 凭据）
│   │   ├── client.ts                # googleapis Drive v3 封装（list/download/mkdir/delete/move）
│   │   ├── resumable-upload.ts      # 可续传上传（gaxios + 会话持久化）
│   │   ├── mount-auth.ts            # MountAuthManager：DriveFS OAuth 凭据管理（环境变量驱动）
│   │   └── mount.ts                 # Drive 挂载执行逻辑（伪 GCE metadata server + DriveFS 启动）
│   │
│   ├── commands/                    # CLI 命令实现
│   │   ├── auth.ts                  # login / status / logout
│   │   ├── runtime.ts               # create / list / destroy / restart
│   │   ├── exec.ts                  # 代码执行（通过守护进程）
│   │   ├── shell.ts                 # 交互式终端：open / attach / list / send
│   │   ├── fs.ts                    # 文件系统操作：upload / download
│   │   ├── drive.ts                 # Drive 操作：login / logout / status / list / upload / download / mkdir / delete / move
│   │   └── drive-mount.ts           # Drive 挂载操作：login / logout / mount / status
│   │
│   ├── output/
│   │   ├── json-output.ts           # --json 模式：全局状态、SilentSpinner、jsonResult()
│   │   └── terminal-renderer.ts     # 将 Jupyter IOPub 消息渲染到终端（打印 savedPaths 路径）
│   │
│   ├── utils/
│   │   ├── uuid.ts                  # UUID 校验 + web-safe base64 转换
│   │   └── proxy.ts                 # WebSocket 代理支持 (https-proxy-agent)
│   │
│   └── logging/
│       └── index.ts                 # console logger，--verbose 控制
│
├── docs/
│   └── colqwen3-embedding-on-colab-l4.md  # Colab L4 嵌入任务实战文档
│
├── package.json
├── tsconfig.json
└── DEVELOPMENT.md                   # ← 本文件
```

---

## 2. 通信架构

### 整体数据流

```
┌────────────┐  Unix Socket  ┌─────────────────┐  WebSocket   ┌─────────────────┐
│ CLI 命令    │ ────────────> │ 守护进程 (daemon) │ ═══════════> │ Colab Kernel    │
│ exec / ... │ <──────────── │                  │ <═══════════ │ (Runtime Proxy) │
└────────────┘   NDJSON      │  KernelConnection│              └─────────────────┘
                              │  KeepAlive       │
                              │  TokenRefresher  │
┌────────────┐   REST        │                  │
│ CLI 命令    │ ────────────> │ (透传到 Colab)    │
│ create/    │ <──────────── │                  │
│ destroy/..│               └─────────────────┘
└────────────┘                       │
                                     │  REST
                                     ▼
                    ┌──────────────────────────────────────────┐
                    │ Colab API (colab.research.google.com)    │
                    │ Colab GAPI (colab.pa.googleapis.com)     │
                    └──────────────────────────────────────────┘
```

**核心设计**：CLI 命令是短暂进程，守护进程是长驻后台进程。WebSocket 长连接由守护进程持有，CLI 命令通过 Unix Socket 与守护进程通信，从而复用同一条 WebSocket 连接。

### 两个域名的职责区分

| 域名 | 用途 | 认证方式 |
|---|---|---|
| `colab.research.google.com` | 传统 API：assign/unassign、keep-alive、session 列表、credentials propagation | Bearer token + `authuser=0` |
| `colab.pa.googleapis.com` | GAPI：user-info、list assignments、refresh connection token | Bearer token |

传统 API 返回的 JSON 有 XSSI 前缀 `)]}'\n`，`ColabClient.issueRequest` 会自动 strip。

### 代理令牌（Proxy Token）

assign 成功后返回 `runtimeProxyInfo: { url, token, tokenExpiresInSeconds }`。后续对 runtime proxy 的所有 REST 和 WebSocket 请求都需要在 header 中带上：

```
X-Colab-Runtime-Proxy-Token: <token>
X-Colab-Client-Agent: cli
```

令牌有时效（通常 1 小时），由守护进程中的 `ConnectionRefresher` 在过期前 5 分钟通过 `ColabClient.refreshConnection()` 刷新。

---

## 3. 守护进程（Daemon）

### 3.1 设计动机

Colab 后端的交互基于长连接。如果每次 `exec` 都临时建立 WebSocket、执行完立即断开，会导致：
- 后端连接不稳定
- 每次 exec 都有数秒的连接建立开销
- 无法在多次 exec 之间保持 Python 变量状态（每次都是新 kernel session）

因此引入守护进程：在 `runtime create` 时启动，持有 WebSocket 长连接，CLI 的 `exec` 命令通过 Unix Socket 与守护进程通信。

### 3.2 进程模型

```
runtime create
  └──> spawn detached child process: node dist/daemon/server.js <server-id>
         │
         ├── 初始化 AuthManager、ColabClient
         ├── 启动 KeepAlive (5 min REST 心跳)
         ├── 启动 ConnectionRefresher (代理令牌刷新)
         ├── 创建 KernelConnection
         ├── 开始 kernel.connect()（异步，可能耗时较长）
         ├── 监听 Unix Socket ← CLI 端检测到此即认为守护进程已就绪
         └── 等待 kernel.connect() 完成
```

守护进程以 `detached: true` 启动，与父进程完全脱离。父进程退出后守护进程继续运行。

**启动顺序说明**：Unix Socket 在 kernel 连接完成 **之前** 就开始监听。这确保了 `startDaemon()` 的 socket 轮询能快速返回，避免在 GPU runtime 冷启动时因 kernel 连接慢而误报"Daemon failed to start within timeout"。如果 exec 请求在 kernel 尚未就绪时到达，守护进程会等待 kernel 连接完成后再处理，而不是立即报错。

### 3.3 文件约定

每个 runtime（server）对应一组守护进程文件，均位于 `~/.config/colab-cli/`：

| 文件 | 用途 |
|---|---|
| `daemon-<server-id>.sock` | Unix Socket，CLI 通过它与守护进程通信 |
| `daemon-<server-id>.pid` | 守护进程 PID，用于检测运行状态和发送信号 |
| `daemon-<server-id>.log` | 守护进程日志（stdout/stderr 重定向至此） |
| `exec-logs-<server-id>/` | 执行历史日志目录（每次执行一个 NDJSON 文件） |

### 3.4 IPC 协议

CLI 与守护进程之间使用 **NDJSON**（Newline-Delimited JSON）通信。

**Client → Server**：

```jsonl
{"type": "exec", "code": "print('hello')"}
{"type": "exec", "code": "long_task()", "background": true}
{"type": "auth_response", "requestId": "<uuid>", "error": "optional error"}
{"type": "stdin_reply", "value": "user input text"}
{"type": "interrupt"}
{"type": "restart"}
{"type": "ping"}
{"type": "exec_attach", "execId": 1}
{"type": "exec_attach", "execId": 1, "noWait": true, "tail": 20}
{"type": "exec_list"}
{"type": "exec_send", "execId": 1, "stdin": "yes"}
{"type": "exec_send", "execId": 1, "interrupt": true}
{"type": "exec_clear"}
{"type": "exec_clear", "execId": 1}
{"type": "shell_open", "cols": 120, "rows": 40}
{"type": "shell_attach", "shellId": 1, "cols": 120, "rows": 40}
{"type": "shell_attach", "shellId": 1, "noWait": true, "tail": 4096}
{"type": "shell_input", "shellId": 1, "data": "ls -la\n"}
{"type": "shell_resize", "shellId": 1, "cols": 140, "rows": 50}
{"type": "shell_detach", "shellId": 1}
{"type": "shell_list"}
{"type": "shell_send", "shellId": 1, "data": "\u0003"}
{"type": "port_forward_create", "localPort": 7860, "remotePort": 7860}
{"type": "port_forward_list"}
{"type": "port_forward_close", "id": 1}
{"type": "port_forward_close", "all": true}
```

**Server → Client**：

```jsonl
{"type": "ready"}
{"type": "auth_required", "requestId": "<uuid>", "authType": "dfs_ephemeral"}
{"type": "input_request", "prompt": "Enter name: ", "password": false}
{"type": "output", "output": {"type": "stream", "name": "stdout", "text": "hello\n"}}
{"type": "exec_done"}
{"type": "exec_error", "message": "..."}
{"type": "exec_started", "execId": 1}
{"type": "exec_attach_batch", "execId": 1, "outputs": [...], "status": "running"}
{"type": "exec_list_result", "executions": [...]}
{"type": "exec_clear_result", "count": 3}
{"type": "restarted"}
{"type": "restart_error", "message": "..."}
{"type": "pong"}
{"type": "shell_opened", "shellId": 1}
{"type": "shell_output", "shellId": 1, "data": "total 24\r\n"}
{"type": "shell_closed", "shellId": 1, "reason": "connection closed"}
{"type": "shell_attached", "shellId": 1, "buffered": "..."}
{"type": "shell_attach_batch", "shellId": 1, "buffered": "...", "status": "running"}
{"type": "shell_list_result", "shells": [...]}
{"type": "shell_send_ack", "shellId": 1}
{"type": "shell_error", "message": "..."}
{"type": "port_forward_created", "id": 1, "localPort": 7860, "remotePort": 7860, "proxyUrl": "https://7860-...colab.dev"}
{"type": "port_forward_list_result", "sessions": [{"id": 1, "localPort": 7860, "remotePort": 7860, "startedAt": "...", "proxyUrl": "..."}]}
{"type": "port_forward_closed", "ids": [1]}
{"type": "port_forward_error", "message": "..."}
```

**通信流程（前台执行）**：

1. CLI 连接 Unix Socket
2. 守护进程发送 `ready`
3. CLI 发送 `exec` 请求
4. 如果 kernel 在执行期间触发 `request_auth`（如 `drive.mount()`），守护进程发送 `auth_required`
5. CLI 前台进程负责浏览器/OAuth 交互，并回送 `auth_response`
6. 如果 kernel 执行 Python `input()` / `getpass()`，守护进程发送 `input_request`
7. CLI 前台进程通过 readline / raw mode 获取用户输入，回送 `stdin_reply`
8. 守护进程继续逐条发送 `output` 消息（流式）
9. 守护进程发送 `exec_done` 或 `exec_error`
10. CLI 断开（守护进程继续运行）

**通信流程（后台执行）**：

1. 用户执行 `colab exec -b` / `colab exec --background`，CLI 发送 `exec` 请求（带 `background: true`）
2. 守护进程发送 `exec_started`（含 execId），CLI 立即退出
3. 执行继续在守护进程中进行，输出缓存在 ExecutionStore
4. 后续 CLI 可通过 `exec_attach`（流式重放 + 续流）或 `exec_attach`（`noWait: true`，快照模式）获取输出
5. `exec_send` 可发送 stdin 或 interrupt 信号到运行中的执行
6. 如果执行期间需要 `input()` 但无 CLI attach，执行挂起等待直到通过 `exec_send` 发送 stdin 或有 CLI attach
7. `exec_clear` 可清理已完成的执行历史（不影响 running/input 状态的执行）

### 3.5 ExecutionStore（执行历史管理）

`src/daemon/execution-store.ts` 在守护进程内持久化所有执行的输出，支持后台执行和输出回放。

**存储结构**：
- 内存：`Map<number, Execution>`，每个 Execution 包含输出数组（上限 10,000 条）
- 磁盘：`~/.config/colab-cli/exec-logs-<server-id>/<execId>.ndjson`，每行一个 JSON 事件

**NDJSON 日志格式**：
```jsonl
{"event":"start","code":"print('hello')","startedAt":"2026-03-29T...","outputDir":"/Users/your-user/.config/colab-cli/outputs/<serverId>/"}
{"event":"output","output":{"type":"stream","name":"stdout","text":"hello\n"}}
{"event":"output","output":{"type":"display_data","data":{"image/png":"...base64..."},"savedPaths":{"image/png":"/path/to/exec1-output-1.png"}}}
{"event":"done"}
```

**恢复机制**：守护进程重启时，扫描日志目录恢复执行历史。从 `start` 事件恢复 `outputDir`，从 `output` 事件中的 `savedPaths` 统计已保存图片数量以重建 `imageCounter`，确保后续执行的文件编号连续。缺少终止事件（`done`/`error`）的执行被标记为错误（"Daemon restarted during execution"）。

**GC 策略**：保留最近 50 次执行，超出后删除最早的已完成执行（含日志文件）。另外 `exec clear` 命令支持手动清理：不带参数清理所有已完成执行，带 ID 清理指定执行。

**显示状态映射**：`exec list` 的 STATUS 列将存储层状态映射为用户可见的标签：

| 存储状态 | 条件 | 显示标签 | 含义 |
|---------|------|---------|------|
| `running` | 无 pendingInput | `running` | 执行中 |
| `running` | 有 pendingInput | `input` | 等待 `input()` 响应 |
| `done` | hasError=false | `done` | 正常完成 |
| `done` | hasError=true | `error` | 完成但有 Python 异常（如 KeyboardInterrupt、ValueError） |
| `error` | — | `crashed` | kernel 进程崩溃（segfault、`os._exit`）、WebSocket 断连、daemon 重启等 |

ELAPSED 列显示执行时长：运行中取 `now - startedAt`，已完成取 `finishedAt - startedAt`，格式为 `Xs`/`XmYs`/`XhYm`。`finishedAt` 持久化在 NDJSON 日志的 `done`/`error` 事件中，daemon 重启后仍能准确还原。

### 3.6 生命周期管理

| 事件 | 行为 |
|---|---|
| `runtime create` | `RuntimeManager.create()` 调用 `startDaemon(serverId)` |
| `exec` | `DaemonClient.connect()` 检测守护进程是否运行，未运行则自动 `startDaemon()` |
| `runtime restart` | 通过 IPC 发送 `restart` 命令，守护进程内部重启 kernel。重启期间 `KernelConnection.isRestarting` 为 `true`，健康检查会跳过 |
| `runtime destroy` | `RuntimeManager.destroy()` 调用 `stopDaemon(serverId)` (SIGTERM)，然后 unassign |
| 守护进程 WebSocket 断开 | 健康检查（30s 间隔）发现 `!isConnected && !isRestarting` 后自动退出，下次 exec 会重启 |
| kernel 崩溃（segfault、`os._exit`） | Colab 自动重启 kernel → 新 kernel 发送 `status: starting` → `KernelConnection.handleMessage()` 检测到后 abort 活跃的 `executeAndStream` generator → `runExecution()` catch 调用 `store.fail()` → `crashed` 状态。参见 §4.7 |
| 系统重启 | PID 文件残留，`isDaemonRunning()` 通过 `kill(pid, 0)` 检测到进程不存在，清理残留文件 |

### 3.7 KernelConnection 的动态 URL

`KernelConnection` 的构造函数接受 `getProxyUrl: () => string`（getter 函数而非静态字符串）。这使得守护进程中的 `ConnectionRefresher` 刷新代理令牌和 URL 后，`KernelConnection` 的后续操作（如 `restartKernel()` 时的 WebSocket 重连）能自动使用最新值。

---

## 4. 关键流程详解

### 4.1 OAuth 登录流程

```
auth-manager.ts: login()
  → loopback-flow.ts: runLoopbackFlow()
      1. 生成 PKCE code_verifier + code_challenge
      2. 生成随机 nonce
      3. 启动本地 HTTP server (127.0.0.1:随机端口)
      4. 构造 Google OAuth URL，通过 `open` 包打开浏览器
      5. 用户在浏览器完成授权 → 重定向回本地 server
      6. 校验 nonce，提取 authorization code
      7. 用 code + code_verifier 换取 tokens
  → 用 access_token 请求 googleapis.com/oauth2/v2/userinfo
  → 存储 { id, refreshToken, account, scopes } 到 ~/.config/colab-cli/auth.json

`--json` 模式后台流程（auth login / drive login / drive-mount login 共用）：
  → background-auth.ts: startBackgroundAuth(authType)
      1. 生成 PKCE、nonce，找到可用端口，构造 OAuth URL
      2. spawn 自身模块为 detached 守护进程（接管 loopback 回调）
      3. 向 stdout 输出 {"event":"auth_required","authType":"...","url":"...","timeoutSeconds":120}
      4. 父进程退出（代理工具可立即读取 URL）
  → 守护进程 runAuthCallbackDaemon()
      1. 在同一端口启动 loopback server
      2. 等待 OAuth 回调（≤120s）
      3. 交换 code → tokens，保存凭证到对应文件
      4. 退出
```

**令牌刷新策略**：每次调用 `getAccessToken()` 时，检查 `expiry_date` 是否在 5 分钟内过期，是则 `oAuth2Client.refreshAccessToken()`。

**错误恢复**：
- `invalid_grant` (status 400) → 清除本地 session，需要重新登录
- OAuth client 切换 (status 401) → 同上

### 4.2 Runtime 创建流程

```
runtime-manager.ts: create()
  → colabClient.assign(randomUUID, { variant, accelerator, shape, version })
      内部两步：
      1. GET /tun/m/assign?nbh=<hash>&variant=GPU[&runtime_version_label=2025.10] → 返回 xsrfToken（或已有 assignment）
      2. POST /tun/m/assign（带 X-Goog-Colab-Token header）→ 返回 assignment
  → 存储 server 信息到 ~/.config/colab-cli/servers.json
  → startDaemon(serverId)
      1. spawn 守护进程 (detached)
      2. 守护进程初始化 auth、colab client
      3. 启动 KeepAlive + ConnectionRefresher
      4. 创建 KernelConnection，开始异步 kernel.connect()
      5. 监听 Unix Socket（无需等待 kernel 就绪）
      6. CLI 端轮询 socket 可连接 → 返回
      7. 守护进程继续等待 kernel.connect() 完成
```

**nbh 参数**：notebook hash，由 `uuidToWebSafeBase64(uuid)` 生成，格式为 44 字符的 web-safe base64（替换 `-` 为 `_`，用 `.` 补齐）。

**Outcome 处理**：
- `QUOTA_DENIED_REQUESTED_VARIANTS` / `QUOTA_EXCEEDED_USAGE_TIME` → `InsufficientQuotaError`
- `DENYLISTED` → `DenylistedError`
- `412 Precondition Failed` → `TooManyAssignmentsError`

### 4.3 代码执行流程

```
exec.ts: execCommand()
  → DaemonClient.connect(serverId)
      1. 检查守护进程是否运行（PID 文件 + kill -0）
      2. 未运行则 startDaemon() 自动启动
      3. 连接 Unix Socket
      4. 等待 ready 消息
  → DaemonClient.exec(code)
      1. 发送 {"type": "exec", "code": "..."} 到 Unix Socket
      2. 守护进程转发到 KernelConnection.execute()
      3. 守护进程将 iopub 消息逐条通过 Unix Socket 发回
      4. CLI 端流式渲染输出
      5. 如果任一 `KernelOutput` 的 `type === "error"`，CLI 在完成后设置 `process.exitCode = 1`
  → DaemonClient.close()

守护进程内部:
  KernelConnection.execute(code)
    1. 发送 execute_request 到 WebSocket shell channel（allow_stdin: true）
    2. 返回 AsyncGenerator<KernelOutput>
    3. 逐个 yield iopub 消息：stream, execute_result, display_data, error, status
    4. 如果 kernel 发送 input_request (stdin channel)，yield InputRequestOutput
       → server.ts 拦截后发送 input_request 到 CLI，等待 stdin_reply → 调用 kernel.sendStdinReply()
    5. 完成条件：收到 execute_reply (shell) AND status:idle (iopub)
```

**消息完成条件**：execute_reply (shell channel) 可能先于 iopub 消息到达。因此必须等待 **两个** 信号都收到才标记执行完成：`gotExecuteReply && gotIdle`。

**SIGINT / Ctrl+C 中断**：exec.ts 在执行期间替换 process SIGINT handler。按 Ctrl+C 调用 `client.interrupt()` 发送 interrupt 消息到守护进程，守护进程通过 `POST /api/kernels/<id>/interrupt` 中断 kernel。kernel 发回 `KeyboardInterrupt` error + `status:idle`，CLI 渲染 traceback 后正常退出。第二次 Ctrl+C 强制 `process.exit(1)`。

**图片输出处理**：`display_data` 和 `execute_result` 类型的 `KernelOutput` 可能包含图片 MIME 数据（如 `plt.show()` 产生的 `image/png`）。图片由守护进程的 `image-saver.ts` 模块立即持久化到磁盘，并在输出上附加 `savedPaths` 字段（MIME → 绝对路径映射）。CLI 端的 `terminal-renderer` 仅打印 `[saved image/png → ...]` 提示，不再执行 base64 解码或文件写入。详见下方 §4.8。

**Jupyter 消息格式**（简化）：

```json
{
  "header": {
    "msg_id": "<uuid>",
    "msg_type": "execute_request",
    "session": "<client_session_id>",
    "username": "username",
    "version": "5.3"
  },
  "parent_header": {},
  "metadata": {},
  "content": {
    "code": "print('hello')",
    "silent": false,
    "store_history": true,
    "user_expressions": {},
    "allow_stdin": true,
    "stop_on_error": true
  },
  "channel": "shell"
}
```

消息路由通过 `parent_header.msg_id` 关联请求和响应。

### 4.4 Ephemeral Auth（Drive 挂载授权）

当 runtime 中的代码执行 `drive.mount()` 或需要 Google 凭据时：

```
1. Runtime 发送 colab_request (msg_type='colab_request', metadata.colab_request_type='request_auth')
2. 守护进程内的 KernelConnection 拦截该消息
3. 分两条路径处理：
   3.1 前台 exec / attach：
       - 守护进程通过 Unix Socket 向前台 CLI 发送 `auth_required { requestId, authType }`
       - 前台 CLI 调用 `auth/ephemeral.ts`
         a. `propagateCredentials(endpoint, { authType, dryRun: true })`
         b. 如果已授权 → 直接 `propagateCredentials(..., dryRun: false)`
         c. 如果未授权 → 在终端提示用户，并以与 `auth login` 一致的格式打印 URL / 打开浏览器
            `--json` 模式下，说明文字和 readline prompt 走 stderr，stdout 额外发出 `{"event":"auth_required", ...}` 事件
         d. 用户在浏览器完成 OAuth 后，前台 CLI 执行 `propagateCredentials(..., dryRun: false)`
       - 前台 CLI 通过 Unix Socket 回送 `auth_response { requestId, error? }`
       - 守护进程收到 `auth_response` 后，向 kernel 发送 `input_reply`
         content.value.type='colab_reply', content.value.colab_msg_id=<id>
   3.2 后台 exec（无 attached socket）：
       - 守护进程先执行一次 `propagateCredentials(..., dryRun: true)` 获取授权 URL
       - 将 URL 记录到 execution store，使 `exec attach --no-wait`、`exec attach --tail` 和 streaming `exec attach` 都能显示该 URL
       - 用户在浏览器完成 OAuth 后，守护进程每 5 秒重试一次 `propagateCredentials(..., dryRun: false)`
       - 成功后自动恢复执行；超时则将执行标记为失败
```

**设计原因**：守护进程是 `detached` 后台进程，不能可靠地直接占用当前终端做交互，也不能在沙箱环境里稳定拉起本机 GUI 浏览器。因此前台 exec 仍由附着的 CLI 承接交互式授权；后台 exec 则改为“显示 URL + daemon 自动轮询传播完成”，避免要求额外的确认命令。

**非交互 JSON 行为**：如果 `--json` 模式下 stdout 被脚本消费且 stdin 不是 TTY，前台 CLI 在需要用户完成浏览器授权时会抛出 `AuthConsentError`；CLI 入口统一转换为 `{"error":"consent_required","authType":"...","url":"..."}`，并以非零状态码退出，避免卡死在不可交互的 `readline` 上。

**本地 Drive 凭据旁路**：当 `MountAuthManager.isConfigured()` 且已授权时（即 DriveFS 环境变量已配置且 `drive-mount login` 已完成），`handleEphemeralAuth()` 对 `DFS_EPHEMERAL` 类型直接 return，跳过整个 `propagateCredentials` 流程。这使得 Python 代码中的 `drive.mount()` 无需浏览器交互——`blocking_request('request_auth')` 成功返回后，`drive.mount()` 再按 Colab 自身逻辑检查是否已挂载。

### 4.5 stdin 透传与 Ctrl+C 中断

当 Python 代码执行 `input()` 或 `getpass.getpass()` 时，kernel 在 stdin channel 发送 `input_request` 消息，等待 `input_reply` 后继续执行。

**完整数据流**：

```
Kernel 执行 input("Enter name: ")
  → kernel 发送 input_request (stdin channel, parent_header.msg_id = execute_request.msg_id)
    → kernel-connection.ts: executeAndStream handler 检测到 channel='stdin', msg_type='input_request'
      → 作为 InputRequestOutput 推入 generator queue（与 iopub 输出同一队列，保证顺序）
        → server.ts: for await 循环遇到 input_request 类型
          → 发送 {"type":"input_request","prompt":"Enter name: ","password":false} 到 CLI
          → 创建 pendingStdinResolve promise 并 await
            → client.ts: exec() generator 收到 input_request
              → 调用 handleStdinRequest(prompt, password) 回调
                → exec.ts: readLine() 通过 readline.question() 提示用户
                ← 用户输入 "Alice" 并回车
              ← 返回 "Alice"
            ← 发送 {"type":"stdin_reply","value":"Alice"} 到守护进程
          ← pendingStdinResolve 被 resolve
        ← 调用 kernel.sendStdinReply("Alice")
      ← 发送 input_reply (channel='stdin', content.value="Alice") 到 WebSocket
    ← kernel 收到输入，input() 返回 "Alice"
  ← kernel 继续执行
```

**Ctrl+C 中断流程**（对齐 `jupyter-kernel-client` 的 `_stdin_hook_default` 行为）：

```
用户在 stdin 等待期间按 Ctrl+C
  → exec.ts: readLine 的 rl.on('SIGINT') 或 readPassword 的 \u0003 触发
    → 调用 onInterrupt() = doInterrupt()
      → client.interrupt() → 发送 {"type":"interrupt"} 到守护进程
    → reject(new Error('interrupted'))  ← 不发送 stdin_reply（kernel 不需要回复了）
  → 守护进程收到 interrupt 消息:
    → kernel.interrupt() → POST /api/kernels/<id>/interrupt
    → pendingStdinResolve(undefined) → for await 解除阻塞，跳过 sendStdinReply
  → kernel 被中断:
    → 发送 error (ename='KeyboardInterrupt') + status:idle → 通过 generator → CLI 渲染 traceback
  → exec.ts: finally 块恢复原始 SIGINT handler
```

**非 stdin 期间的 Ctrl+C**：terminal 处于 cooked mode，Ctrl+C 产生 process SIGINT → `doInterrupt()` → `client.interrupt()`。kernel 中断后发回 error + idle，CLI 渲染后正常退出。

**password 模式**：当 `input_request.content.password === true`（Python `getpass.getpass()` 触发），`readPassword()` 使用 raw mode 读取，不回显字符。

**非 TTY 行为**：当 `process.stdin.isTTY === false`（管道输入等），`handleStdinRequest` 返回空字符串。

**排序保证**：`input_request` 通过与 iopub 输出相同的 generator queue 流转（`executeAndStream` handler 统一推送）。由于 Colab 使用单条多路复用 WebSocket，消息到达顺序即发送顺序，因此 `print()` 的输出一定在 `input()` 的 prompt 之前被渲染。

**源码溯源**：

| 逻辑 | 来源项目 | 原始位置 | 迁移说明 |
|------|----------|----------|----------|
| stdin hook 模式（password 区分 + SIGINT 处理 + 不发送 reply） | jupyter-kernel-client | `wsclient.py:1307-1338` (`_stdin_hook_default`) | 核心逻辑直接翻译为 Node.js：`getpass`→`readPassword`(raw mode)，`input`→`readLine`(readline)，SIGINT double-handler→`doInterrupt()`+`reject` |
| `input()` 方法（构造 `input_reply` 消息） | jupyter-kernel-client | `wsclient.py:1135-1147` (`input()`) | `KernelConnection.sendStdinReply()` 完全对齐：`content: { value }`, `channel: 'stdin'` |
| `execute_interactive()` 的 stdin/iopub 交替轮询 | jupyter-kernel-client | `wsclient.py:1070-1112` (`execute_interactive`) | 架构差异：原实现在单线程同步循环中交替检查两个 channel queue；colab-cli 使用 async generator + daemon IPC，通过同一 queue 保证顺序 |
| `allow_stdin: true` 在 execute_request 中 | jupyter-kernel-client | `wsclient.py:971` | `kernel-connection.ts:143` 已有此设置（原始实现即包含） |
| daemon IPC 的 request/reply 模式 | colab-cli 自身 | `auth_required` / `auth_response` 模式 | `input_request` / `stdin_reply` 完全复刻相同模式，包括 pending resolve、socket close 清理 |
| interrupt 中取消 pending stdin | jupyter-kernel-client | `wsclient.py:1328-1330`（KeyboardInterrupt → return 不发 reply） | `server.ts` interrupt case 将 `pendingStdinResolve(undefined)` → for await 跳过 `sendStdinReply` |
| SIGINT handler 保存/恢复 | jupyter-kernel-client | `wsclient.py:1312-1333`（`signal.signal` save/restore） | `exec.ts` 使用 `process.rawListeners('SIGINT')` save/restore |
| 第二次 Ctrl+C force exit | 无对应（CLI 特有） | — | `doInterrupt()` 中 `if (interrupted) process.exit(1)` |

### 4.6 内核重启

```
CLI: runtime restart
  → DaemonClient.connect(serverId)
  → DaemonClient.restart()
      → 发送 {"type": "restart"} 到 Unix Socket

守护进程内部:
  KernelConnection.restartKernel()
    0. 设置 _restarting = true（抑制健康检查误判）
    1. 关闭现有 WebSocket（此时 isConnected 为 false）
    2. POST /api/kernels/<kernel_id>/restart（REST API，使用 getProxyUrl() 获取最新 URL）
    3. 重新建立 WebSocket 到同一 kernel_id
    4. 等待 status: idle
    5. 恢复 _restarting = false（finally 块中执行，即使失败也会恢复）
```

重启只杀 Python 进程，不销毁 VM。用于 `%pip install` 后重载模块。

### 4.7 Kernel 崩溃检测

当 kernel 进程崩溃（segfault、`os._exit`、OOM kill 等），Colab 代理自动重启 kernel，但 WebSocket 连接保持打开（连接的是 Colab 代理，不是 kernel 进程本身）。这导致 `executeAndStream()` 永远等待不会到来的 `execute_reply` + `status:idle` 消息。

**两层检测机制**：

```
Layer 1 — status:starting 检测（主要路径）:

  Kernel 崩溃 → Colab 自动重启 kernel
    → 新 kernel 在 iopub 广播 status: starting（无 parent_header.msg_id）
      → handleMessage() 全局路径检测到 execution_state === 'starting'
        → 调用 activeExecutionAbort(new Error('Kernel restarted during execution'))
          → generator queue 收到 { error } → 抛出异常
            → runExecution() catch: store.fail(execId, message) → crashed 状态
              → finally: activeExecution = undefined → 允许新执行

Layer 2 — WebSocket close（回退路径）:

  WebSocket 连接断开（网络中断等）
    → ws.on('close') 调用 activeExecutionAbort(new Error('WebSocket closed during execution'))
      → 同上 generator abort 流程 → crashed 状态
```

**与显式重启的交互**：`restartKernel()` 先 `removeAllListeners()` 再 `close()` → 旧 close handler 不触发。但新 WS 的 `handleMessage()` 检测到 `status: starting` 后仍会 abort 活跃执行，这是正确行为。

**`status: starting` 的安全性**：根据 Jupyter 协议，`execution_state: starting` 仅在 kernel 生命周期事件（首次启动、重启）时出现。正常执行只有 `busy` → `idle` 转换，不会误触发。

**源码溯源**：

| 逻辑 | 来源项目 | 原始位置 | 迁移说明 |
|------|----------|----------|----------|
| 连接断开时中止活跃执行 | jupyter-kernel-client | `wsclient.py` `_on_close()` → `connection_ready.clear()` + `execute_interactive()` 检查 `connection_ready.is_set()` | `activeExecutionAbort` 回调模式替代 Event flag，通过 generator queue 传播错误 |
| kernel 状态监控 | vscode-jupyter | `kernelCrashMonitor.ts` 监控 `status: 'dead'` / `'autorestarting'` | 简化为检测 `status: starting`，因为 Colab 代理不透传 `dead`/`autorestarting` 状态 |

### 4.8 图片输出保存

当执行的代码产生图片输出（`plt.show()`、`IPython.display.Image()` 等）时，Jupyter kernel 通过 iopub 发送 `display_data` 或 `execute_result` 消息，其 `data` 字段包含多种 MIME 表示（如 `image/png` 的 base64 编码、`text/plain` 的文本回退）。

**守护进程内立即持久化**：图片由 `daemon/image-saver.ts` 中的 `saveOutputImages()` 函数在 `execution-store.ts` 的 `appendOutput()` 流程中立即保存到磁盘。原始 base64 数据保留在 `data` 字段作为稳定备份（NDJSON 日志），同时在输出上附加 `savedPaths: Record<string, string>` 字段（MIME → 绝对路径映射）。

```
saveOutputImages(output, execId, outputDir, startCounter)
  for each (mime, content) in output.data:
    1. 查找 imageExtensionForMimeType[mime] → ext（未命中则跳过）
    2. 递增 counter → 生成文件路径 exec<execId>-output-<n>.<ext>
    3. 写入文件：SVG 为 UTF-8 文本，其余 Buffer.from(base64)
    4. 记录到 savedPaths[mime] = filePath
  return { output: {...output, savedPaths}, nextCounter }
```

**文件命名规则**：文件名为 `exec<execId>-output-<n>.<ext>`，跨执行隔离——即使多个执行共享同一 `outputDir`，文件名也不会冲突。

**保存目录策略**：

| 场景 | 目录 |
|------|------|
| 用户指定 `--output-dir ./plots` | `./plots/`（CLI 端解析为绝对路径后通过 IPC 传递给守护进程） |
| 未指定（默认） | `~/.config/colab-cli/outputs/<serverId>/`（per-server 目录） |

`exec.ts` 中的 `resolveOutputDir()` 负责将用户提供的相对路径解析为绝对路径（基于 CLI 的 CWD），并展开 `~` 前缀。这是必要的，因为守护进程是长驻后台进程，其 CWD 与用户终端几乎不会一致。

**CLI 端渲染**：`terminal-renderer.ts` 仅读取 `output.savedPaths` 并打印 `[saved <mime> → <path>]`，不再执行 base64 解码或文件写入。

**恢复机制**：守护进程重启时，`ExecutionStore` 从 NDJSON 日志重建 `imageCounter`，确保后续执行的文件编号连续。

**I/O 容错**：写入失败时记录日志但不中止执行，NDJSON 中的 base64 数据作为最终回退。

**源码溯源**：

| 逻辑 | 来源 | 原始位置 |
|------|------|----------|
| MIME→扩展名映射 (`image/png` → `png` 等) | vscode-jupyter | `src/webviews/extension-side/plotView/plotSaveHandler.ts:14-18` (`imageExtensionForMimeType`) |
| `data` 字段包含所有 MIME 类型（base64 图片 + text/plain 回退） | jupyter-kernel-client | `jupyter_kernel_client/client.py:24-105` (`output_hook()`)，`data: content.get("data")` 原样透传 |
| SVG 为原始文本、二进制图片为 base64 | Jupyter wire protocol | [Jupyter messaging spec: display_data](https://jupyter-client.readthedocs.io/en/stable/messaging.html#display-data) |
| `Buffer.from(base64)` 写入文件 | vscode-jupyter | `plotSaveHandler.ts:88` (`fs.writeFile(target, data.data)`)，colab-cli 使用 Node.js `Buffer` 等价实现 |

### 4.9 文件传输流程

文件传输通过 Jupyter Contents API（REST）实现，不走 WebSocket。上传和下载共享相同的策略选择和分块逻辑。

**策略选择**（`transfer/common.ts: chooseStrategy()`）：

| 文件大小 | 策略 | 说明 |
|----------|------|------|
| ≤ 20 MiB | `direct` | 单次 REST 请求（PUT/GET） |
| 20–500 MiB | `chunked` | 分块并发传输，每块 20 MiB，最多 25 并发 |
| > 500 MiB | `drive` | 预留接口，尚未实现（计划 Google Drive） |

**为什么不用生成的 `ContentsApi`**：生成代码对整个路径做 `encodeURIComponent`，会把 `/` 编码为 `%2F`。`jupyter/contents-client.ts` 手写实现，对每个路径段分别编码。

**上传流程（`transfer/upload.ts`）**：

```
fs.ts: fsUploadCommand()
  → 检查文件大小 → chooseStrategy()
  → direct:
      1. 读取文件 → base64
      2. PUT /api/contents/<path>（带重试 + 验证）
  → chunked:
      1. 连接 DaemonClient（用于内核拼装）
      2. 创建远程临时目录 content/.colab-transfer-tmp/<id>/parts/
      3. 分块读取本地文件 → base64 → 并发 PUT 到临时目录（每块带重试 + 验证）
      4. 上传 manifest.json
      5. 通过 daemon 执行 Python 拼装代码（shutil.copyfileobj 逐块拼接）
      6. 验证最终文件大小
```

**下载流程（`transfer/download.ts`）**：

```
fs.ts: fsDownloadCommand()
  → getContentsMetadata() 获取文件大小 → chooseStrategy()
  → direct:
      1. GET /api/contents/<path>?format=base64&type=file（带重试）
      2. base64 解码 → 写入本地
  → chunked:
      1. 连接 DaemonClient（惰性连接，仅 chunked 时）
      2. 通过 daemon 执行 Python 切分代码（将文件切为 20 MiB 块到临时目录）
      3. 并发 GET 每个块（base64）→ 解码为 Buffer
      4. 按序写入本地文件
      5. 验证本地文件大小
      6. 通过 daemon 执行 Python 清理临时目录
```

**共享基础设施（`transfer/common.ts`）**：

- `ConnectionProvider` 接口：抽象 `getProxyUrl()` / `getToken()`，每次调用重新读取 `servers.json` 获取最新令牌
- `runPool()`: 有界并发池，控制同时进行的 HTTP 请求数
- `buildChunkPlan()`: 按固定块大小（20 MiB）切分文件
- `ensureRemoteDirectory()` / `ensureRemoteParents()`: 远程目录创建
- 常量：`DIRECT_LIMIT_BYTES` (20 MiB)、`DEFAULT_CHUNK_SIZE_BYTES` (20 MiB)、`DEFAULT_MAX_CONCURRENCY` (25)

**实测性能**（通过代理连接 Colab）：

| 场景 | 吞吐量 |
|------|--------|
| 上传 21 MiB (2 块并发) | ~0.53 MiB/s |
| 上传 150 MiB (8 块并发) | ~1.15 MiB/s |

并发带来明显增益，但非线性（受 Colab 代理层和网络带宽限制）。

### 4.10 交互式终端（Shell）

在 runtime 上开启交互式终端。daemon 持有到 `/colab/tty` 的 WebSocket 长连接，CLI 客户端可 attach/detach，类似 tmux。

**与 exec 的核心区别**：exec 走 Jupyter kernel 协议（结构化消息、单线程执行队列），shell 走原始 TTY 字节流（无状态 WebSocket、多会话并发上限 10 个）。两者共享 daemon IPC 架构，但消息类型和会话管理完全独立。

#### 4.10.1 WebSocket 协议（`/colab/tty`）

终端 WebSocket 端点由 Colab 代理提供，协议极简：

```
连接: wss://<proxyUrl>/colab/tty
认证: X-Colab-Runtime-Proxy-Token header

发送（JSON）:
  {"data": "ls -la\n"}              # 输入数据
  {"cols": 120, "rows": 40}         # 终端尺寸变更

接收（JSON）:
  {"data": "total 24\ndrwxr..."}    # 输出数据
```

端点是无状态的——断开 WebSocket 即丢失 shell 会话，无法重连。这是 daemon 代理层存在的核心原因。

#### 4.10.2 Daemon 终端会话管理

```
ActiveShell {
  shellId: number               # 自增 ID（独立于 exec 编号）
  connection: TerminalConnection # WebSocket → /colab/tty
  buffer: TerminalBuffer         # 环形缓冲区（100KB），attach 时回放
  attachedSocket?: net.Socket    # 当前绑定的 CLI 客户端（可为空）
  startedAt: Date
  status: 'running' | 'closed'
}
```

与 exec 的 `activeExecution` 不同，shell 支持多个并发会话（`Map<number, ActiveShell>`，上限 `MAX_CONCURRENT_SHELLS = 10`）。每个 shell 独立持有自己的 WebSocket 和 Buffer。

**输出分发逻辑**：WebSocket 收到数据时，同时写入 `buffer.append()` 和 `attachedSocket`（如果有）。CLI detach 后输出仍持续缓冲，re-attach 时通过 buffer 回放。

**Snapshot 输出后处理**：`--no-wait` / `--tail` 模式（snapshot）获取缓冲内容时，通过 `getContents(tailBytes, snapshot=true)` 对原始终端输出进行渲染后处理：①  `stripAnsi()` 剥离 ANSI escape sequences（SGR 颜色、光标移动等）；② `resolveCarriageReturns()` 模拟 `\r` 覆写语义——将同一行内多次 `\r` 分隔的进度更新（如 `git clone`、`pip install` 的进度条）折叠为最终可见状态；③ 组合输出经 `renderForSnapshot()` 整理后返回。交互式 attach 模式（streaming）不做后处理，直接透传原始数据以保留 ANSI 着色等终端特性。

**关闭后保留窗口**：shell 关闭或出错后不会立刻从 `shellState.shells` 删除，而是保留约 5 分钟。这样 `shell list` 和 `shell attach --no-wait` 仍可查看 `status=closed` 与最终缓冲输出；超时后再清理以释放内存。

#### 4.10.3 数据流：前台交互模式

```
colab shell               Daemon                    Colab Runtime
    |-- shell_open -------->|                           |
    |                       |-- WS wss://.../colab/tty->|
    |<-- shell_opened ------|                           |
    |-- shell_attach ------>|  [attachedSocket=socket]  |
    |<-- shell_attached ----|  [buffered=""]            |
    |  [raw mode, live I/O] |                           |
    |                       |                           |
    |  [Ctrl+\]             |                           |
    |-- shell_detach ------>|  [attachedSocket=null]    |
    |  [exit]               |  [WS stays alive]        |
    .                       |<-- {"data":"..."} ------->|
    .                       |  [buffer.append()]        |
                            .                           .
colab shell attach 1       Daemon                    Colab Runtime
    |-- shell_attach ------>|  [attachedSocket=new]    |
    |<-- shell_attached ----|  [buffered=缓冲内容]      |
    |  [write buffered]     |                           |
    |  [raw mode, live I/O] |                           |
```

关键点：`shell_open` **不设** `attachedSocket`——调用方决定是立即 attach（前台 `colab shell`）还是不 attach（后台 `colab shell -b`）。

若另一个 CLI 客户端 attach 到同一 shell，daemon 会先向旧客户端发送 `shell_closed(reason="detached by another client")`，再把 `attachedSocket` 切换到新客户端，避免旧客户端静默失去输出。

#### 4.10.4 数据流：Agent 非阻塞模式

Agent 的终端命令执行工具是阻塞的（如 Claude Code 的 Bash 工具），不能卡在交互式命令上。shell 提供完整的非阻塞 API：

```
colab shell -b             Daemon                    Colab Runtime
    |-- shell_open -------->|-- WS connect ----------->|
    |<-- shell_opened ------|   {shellId: 1}            |
    |  [print "1", exit]    |   [no attachedSocket]     |

colab shell send 1         Daemon                    Colab Runtime
  --data "ls\n"            |                           |
    |-- shell_send -------->|-- {"data":"ls\n"} ------>|
    |  [exit immediately]   |<-- {"data":"file1..."} ---|
                            |   [buffer.append()]       |

colab shell attach 1       Daemon                    Colab Runtime
  --no-wait                |                           |
    |-- shell_attach ------>|                           |
    |   {noWait: true}      |                           |
    |<-- shell_attach_batch-|                           |
    |   {buffered, status}  |                           |
    |  [print, exit]        |                           |
```

#### 4.10.5 输入模型：为什么不需要 exec 的 `--stdin`/`--interrupt`

exec 的输入是 Jupyter kernel 协议的特殊机制（`input_request` → `stdin_reply`），中断是独立 REST API（`POST /api/kernels/<id>/interrupt`）。

terminal 的输入是原生 TTY 字节流——**所有键盘输入**（包括信号）都是 WebSocket `{"data": ...}` 中的原始字节：

| 按键 | 字节 | 远端效果 |
|------|------|---------|
| Ctrl+C | `\x03` | 远端 TTY driver 解释为 SIGINT，中断前台进程 |
| Ctrl+D | `\x04` | EOF，关闭 shell |
| Ctrl+Z | `\x1a` | SIGTSTP，暂停前台进程 |
| Ctrl+\ | `\x1c` | **CLI 本地拦截** → detach（唯一不透传的键） |

因此 `colab shell send --signal INT` 只是 `--data "\x03"` 的易记别名，底层走同一代码路径。

`shell_send` 现在采用显式 ack 语义：daemon 成功写入终端 WebSocket 后返回 `shell_send_ack`；如果 shell 不存在或已关闭则返回 `shell_error`。这样 CLI 不会把对失效 shell 的发送误判为成功。

#### 4.10.6 源码溯源

| colab-cli | colab-vscode 源文件 | 迁移说明 |
|-----------|---------------------|---------|
| `terminal/terminal-connection.ts` | `colab/terminal/colab-terminal-websocket.ts` (`ColabTerminalWebSocket`) | **移植**：保留核心逻辑——WebSocket 连接 `wss://<proxy>/colab/tty`、JSON 消息格式（`{"data":...}` / `{"cols":N,"rows":N}`）、pending message queue（CONNECTING 时入队，OPEN 后 flush）、disposed guard、readyState 检查。去掉：VS Code `EventEmitter`/`Disposable`/`Event` 接口 → 改为构造函数 `handlers` 回调；`ColabAssignedServer` → 改为 `getProxyUrl()`/`getToken()` getter（对齐 `KernelConnection` 模式）；`WebSocketClass` 注入（测试用）→ 直接 `import WebSocket`；`unexpected-response` handler（CLI 不需要 HTTP 响应体诊断）。新增：30s 连接超时、`connect()` 返回 `Promise<void>` 而非同步 void（daemon 需要 await 连接就绪）、`getProxyAgent()` 代理支持 |
| `terminal/terminal-buffer.ts` | 无对应 | **全新**：colab-vscode 直接操作 VS Code Terminal 面板（输出即时渲染，无缓冲需求）。colab-cli 因 daemon detach/attach 模式需要缓冲历史输出，使用有界环形缓冲区（100KB 上限，chunk-level 淘汰，支持 `tailBytes` 截取）。Snapshot 模式（`--no-wait`/`--tail`）额外经 `renderForSnapshot()` 后处理：剥离 ANSI escapes、模拟 `\r` 覆写折叠进度条输出，使非交互消费方（Agent 等）获得干净的可见文本而非原始终端字节流 |
| `commands/shell.ts` `runShellSession()` | `colab/terminal/colab-pseudoterminal.ts` (`ColabPseudoTerminal`) | **重写**：colab-vscode 通过 VS Code `Pseudoterminal` 接口桥接（`handleInput()` → WS send、`onDidWrite` ← WS receive、`setDimensions()` → WS resize）。colab-cli 因无 VS Code API，直接操作 `process.stdin`（raw mode）和 `process.stdout`：stdin `data` → `shellInput`、`SIGWINCH` → `shellResize`、`shellStream` → stdout write。新增 `Ctrl+\` detach 拦截（colab-vscode 终端面板关闭即断开，无 detach 概念） |
| `commands/shell.ts` 命令结构 | `colab/commands/terminal.ts` (`openTerminal()`) | **重写**：colab-vscode 仅一个 `openTerminal()` 入口（创建 VS Code 终端面板）。colab-cli 拆分为 5 个子命令（`shell`/`attach`/`list`/`send` + 共享 `runShellSession`）以支持 daemon bg/attach 和 Agent 非阻塞模式 |
| `daemon/server.ts` shell 会话管理 | 无对应 | **全新**：daemon 侧 `ActiveShell` 状态管理、多会话并发（Map + 上限 10）、attachedSocket 路由、buffer 缓冲、`shell_open`/`shell_attach`/`shell_detach`/`shell_list`/`shell_send` 消息处理 |
| `daemon/protocol.ts` shell 消息 | 无对应 | **全新**：7 个 `ClientMessage` + 8 个 `ServerMessage` 变体，`ShellStatus`/`ShellListEntry` 类型。`shell_send_ack` 显式确认发送成功，避免向已失效 shell 发送时静默成功。设计参考 exec 的 IPC 消息模式 |
| `daemon/client.ts` shell 方法 | 无对应 | **全新**：`shellOpen`/`shellAttach`/`shellAttachSnapshot`/`shellList`/`shellSend`/`shellStream` 等方法，模式对齐 exec 的 `execBackground`/`execAttach`/`execAttachSnapshot`/`execList` |

**总结**：从 colab-vscode 直接移植的是 WebSocket 协议层（`terminal-connection.ts` ← `colab-terminal-websocket.ts`），保留了连接建立、消息编解码、pending queue 等核心逻辑。VS Code 终端面板的 PTY 桥接层（`colab-pseudoterminal.ts`）被完全重写为 CLI raw mode 交互。daemon 侧的会话管理、缓冲、IPC 协议、bg/attach 模式均为 colab-cli 全新实现——colab-vscode 没有对应概念（VS Code 终端面板关闭即断开，无 detach/re-attach 支持）。

### 4.11 端口转发（Port Forwarding）

将 runtime 上运行的 Web 服务（Gradio、Streamlit、TensorBoard、Flask/FastAPI 等）转发到本地 `http://localhost:<port>`，无需 ngrok 或 share link。

**核心原理**：Colab 基础设施本身支持任意端口的 L7 反向代理——`v1/runtime-proxy-token` API 接受 `port` 查询参数，返回 `https://<PORT>-<endpoint>.<domain>.colab.dev` 形式的代理 URL 和签名 token。colab-cli 在 daemon 里启动一个本地 HTTP 反向代理，将请求透传到该代理 URL，自动注入 token header。

**覆盖范围**：HTTP 和 WebSocket。不支持原始 TCP 协议（PostgreSQL wire、Redis RESP、SSH、gRPC-over-HTTP2 等）。

#### 4.11.1 架构

```
curl http://localhost:7860            (用户浏览器 / 本地程序)
    │
    ▼
[daemon 本地 TCP 监听 127.0.0.1:7860]
    │ http-proxy 透传 + 注入 X-Colab-Runtime-Proxy-Token header + 替换 Host
    ▼
https://7860-<endpoint>.<domain>.colab.dev    (Google 边缘代理)
    │ 子域名 → 内部端口路由
    ▼
127.0.0.1:7860 in runtime VM (Gradio/Streamlit/...)
```

#### 4.11.2 Token 管理

每个转发端口使用独立的 `PortTokenRefresher`（`src/port-forward/token-refresher.ts`），参考 `ConnectionRefresher` 的定时刷新模式：

- 首次 `start()` 时调用 `ColabClient.refreshConnection(endpoint, port)` 获取初始 token
- 在 TTL 到期前 5 分钟自动刷新（`REFRESH_MARGIN_MS = 5 * 60 * 1000`）
- 刷新失败时 30 秒后重试
- 与 `ConnectionRefresher` 的区别：不调用 `updateServerToken()`（per-port token 不持久化，daemon 重启时重新获取）

`ColabClient.refreshConnection()` 新增可选 `port` 参数（默认 `8080` 保持向后兼容），对现有 `ConnectionRefresher` 的调用零影响。

#### 4.11.3 HTTP/WS 反向代理

使用 `http-proxy` 库（`src/port-forward/forwarder.ts`）：

- `changeOrigin: true`：自动重写 `Host` header 为目标域名
- `ws: true`：支持 WebSocket upgrade
- **Origin/Referer 请求头重写**：浏览器对 `localhost` 页面发起的请求会携带 `Origin: http://localhost:PORT`，Colab 边缘代理对不匹配的 Origin 返回 404。因此在 `proxy.web()`/`proxy.ws()` 前将 `req.headers.origin` 重写为 Colab 代理 URL，`referer` 同理保留路径部分仅替换 scheme+host
- **CORS 响应头重写**：上游 `Access-Control-Allow-Origin` 会回显 Colab 代理域名，浏览器 CORS 检查会因 origin 不匹配而拒绝 fetch/XHR 响应。通过 `proxyRes` 事件将 `Access-Control-Allow-Origin` 重写为 `http://localhost:PORT`
- 每个请求通过 `headers` 选项注入最新 token 和 `X-Colab-Client-Agent`
- 错误处理：HTTP 请求返回 502，WebSocket 连接直接 destroy socket
- 支持 `HTTPS_PROXY` 环境变量（通过 `getProxyAgent()`）

**已知局限（localhost 代理固有问题）**：

- **302 重定向**：如果被代理的应用返回绝对 URL 的 `Location` 头指向 Colab 代理域名，浏览器会直接跳转到 Colab 域名而绕过本地代理。目前未重写 `Location` 头——如遇此问题可在 `proxyRes` 中添加重写逻辑
- **Set-Cookie Domain/Secure**：上游设置的 `Domain=.colab.dev` cookie 不会被浏览器存储到 localhost 下；`Secure` 标记的 cookie 不会通过 HTTP 发送。会影响依赖服务端 session 的应用
- **Mixed Content**：本地代理服务于 HTTP，若页面中包含对自身 HTTPS 域名的硬编码引用可能触发混合内容策略

#### 4.11.4 会话管理

`ForwardSession`（`src/port-forward/session.ts`）组合 token refresher 和 HTTP server：

- `ForwardSession.open()` 依次启动 token refresher、创建 forwarder、绑定本地端口
- 端口冲突（`EADDRINUSE`）直接抛出错误，提示用户使用 `LOCAL:REMOTE` 形式换端口
- `ForwardSession.close()` 停止 refresher 并关闭 server
- daemon 进程退出时统一关闭所有 session

并发上限 `MAX_CONCURRENT_PORT_FORWARDS = 20`。

#### 4.11.5 CLI 命令

```bash
colab port-forward create 7860                  # local 7860 → remote 7860
colab port-forward create 18080:7860            # local 18080 → remote 7860
colab port-forward list                         # 列出活跃转发
colab port-forward close 1                      # 按 ID 关闭
colab port-forward close --all                  # 关闭全部
```

`pf` 是 `port-forward` 的别名。`create` 成功后 CLI 立即返回，daemon 持有 listener。

#### 4.11.6 源码溯源

| colab-cli | colab-vscode 源文件 | 迁移说明 |
|-----------|---------------------|---------|
| `port-forward/token-refresher.ts` | `colab/connection-refresher.ts` | **参考**：参照 `ConnectionRefresher` 的定时刷新模式，去掉 `updateServerToken()` 持久化。构造函数接受 `port` 参数，调用 `refreshConnection(endpoint, port)` |
| `port-forward/forwarder.ts` | 无对应 | **全新**：基于 `http-proxy` 的 L7 反向代理，注入 token header，支持 HTTP 和 WebSocket |
| `port-forward/session.ts` | 无对应 | **全新**：组合 `PortTokenRefresher` + `http.Server`，管理单个转发的完整生命周期 |
| `commands/port-forward.ts` | 无对应 | **全新**：`create`/`list`/`close` 三个子命令，spec 解析（`PORT` 或 `LOCAL:REMOTE`） |
| `daemon/server.ts` 端口转发处理 | 无对应 | **全新**：`forwardState` 管理、`port_forward_create`/`list`/`close` 消息处理、进程退出时清理 |
| `daemon/protocol.ts` 端口转发消息 | 无对应 | **全新**：3 个 `ClientMessage` + 4 个 `ServerMessage` 变体，`PortForwardListEntry` 类型 |
| `daemon/client.ts` 端口转发方法 | 无对应 | **全新**：`portForwardCreate`/`portForwardList`/`portForwardClose` 方法 |
| `colab/client.ts` `refreshConnection` | `colab/client.ts` | **改进**：新增可选 `port` 参数（默认 8080），向后兼容 |

---

## 5. Google Drive 管理

### 5.1 认证架构

Drive 使用**独立的 OAuth 流程**，与 Colab 主登录分离。原因：Colab VS Code 扩展的 GCP 项目未注册 Drive API（尝试添加 `drive` scope 会返回 `restricted_client` 错误）。

| 项 | Colab 登录 | Drive 登录 |
|---|---|---|
| OAuth Client | Colab 扩展凭据 | rclone 公共凭据（默认），可通过 `COLAB_DRIVE_CLIENT_ID` 覆盖 |
| Scope | `profile email colaboratory` | `email drive` |
| 存储文件 | `~/.config/colab-cli/auth.json` | `~/.config/colab-cli/drive-auth.json` |
| 触发时机 | `colab auth login` | `colab drive login` |

`DriveAuthManager`（`drive/auth.ts`）：
- 使用与主登录相同的 `runLoopbackFlow()` 执行 OAuth
- 存储 `{ refreshToken, clientId, email }` 到 `drive-auth.json`
- 检测 `clientId` 变更 → 自动触发重新授权
- `getAccessToken()` 在令牌过期前 5 分钟自动刷新
- `logout()` 通过 `revokeToken(refreshToken)` 撤销服务端令牌后删除本地文件
- 数据操作子命令（list/upload/download 等）要求先 `drive login`，未授权时报错退出

### 5.2 Drive API 封装

`drive/client.ts` 使用 `googleapis` npm 包（Drive v3 API）：

```typescript
function createDriveClient(accessToken: string): drive_v3.Drive
// 每次调用创建新的 OAuth2Client，注入 access_token
```

核心函数：

| 函数 | 用途 |
|---|---|
| `listFiles(token, parentId?, pageToken?)` | 列出文件夹内容（100 项/页，按 folder+name 排序，也支持查看分享给你的文件） |
| `getFileMetadata(token, fileId)` | 获取单个文件元数据（含 md5Checksum） |
| `downloadFile(token, fileId, destPath)` | 流式下载到本地 |
| `createFolder(token, name, parentId?)` | 创建文件夹 |
| `trashFile(token, fileId)` | 移至回收站 |
| `permanentlyDelete(token, fileId)` | 永久删除 |
| `moveDriveItem(token, itemId, newParentId)` | 移动 Drive 项（文件或文件夹，PATCH addParents/removeParents） |
| `findFileByName(token, fileName, parentId)` | 按名称查找文件（用于 MD5 去重） |

**所有参数均使用 raw ID**：Google Drive 允许同一文件夹内存在同名文件/文件夹，因此基于名称/路径的解析不稳健。所有命令的文件/文件夹参数统一使用 Drive file ID，用户通过 `list` 获取 ID。未指定父文件夹时默认为 `root`。

`drive move` 对自己不拥有的文件会退化为复制；自己拥有的文件仍按正常移动处理。

### 5.3 可续传上传

`drive/resumable-upload.ts` 使用 `gaxios`（googleapis 的 HTTP 层）手动实现 Google Drive resumable upload protocol，而非 googleapis 的高层 `files.create`。原因：需要持久化 session URI 实现跨进程断点续传。

**上传策略**：

| 文件大小 | 策略 | 说明 |
|----------|------|------|
| ≤ 5 MiB | multipart | 单次请求，`uploadType=multipart` |
| > 5 MiB | resumable | `uploadType=resumable`，8 MiB 分块 |

**Resumable 流程**：

```
1. POST /upload/drive/v3/files?uploadType=resumable
   → 返回 Location header = session URI
2. PUT session URI (Content-Range: bytes 0-8388607/totalBytes)
   → 308 Resume Incomplete（返回 Range header 确认已收字节）
   → 200/201 Upload Complete（返回 file metadata）
3. 每块完成后更新本地 state 文件
4. 上传完成后删除 state 文件
```

**断点续传**：
- Session state 持久化到 `~/.config/colab-cli/drive-uploads/{sha256-hash}.json`
- 重新执行同一上传命令时，检测 state 文件 → 查询 session 状态 → 从断点继续
- Session 过期（404）→ 清除 state，重新开始

**MD5 去重**：上传前通过 `findFileByName()` 检查目标文件夹是否已存在同名文件，若存在且 MD5 匹配则跳过上传。

**错误重试**：5xx 服务器错误和网络错误使用指数退避重试（最多 5 次，1s/2s/4s/8s/16s）。

### 5.4 自动 Drive 挂载

自动挂载功能绕过 Colab 的 `propagateCredentials` 流程，在 runtime 内启动一个伪 GCE metadata server 向 DriveFS 提供令牌，实现零浏览器交互的 Drive 挂载。

**前提条件**：需要设置 `COLAB_DRIVEFS_CLIENT_ID` 和 `COLAB_DRIVEFS_CLIENT_SECRET` 环境变量。未配置时，`drive-mount` 命令组在 CLI 中隐藏，回退到标准的浏览器 ephemeral auth 流程。

**认证架构**：

| 项 | Drive 管理（`colab drive`） | Drive 自动挂载（`colab drive-mount`） |
|---|---|---|
| OAuth Client | rclone 公共凭据（默认） | DriveFS 内嵌凭据（环境变量） |
| Scope | `email drive` | `email drive` |
| 存储文件 | `~/.config/colab-cli/drive-auth.json` | `~/.config/colab-cli/drive-mount-auth.json` |
| 触发时机 | `colab drive login` | `colab drive-mount login` |

`MountAuthManager`（`drive/mount-auth.ts`）：
- 静态方法 `isConfigured()` 检查环境变量是否设置（不实例化即可调用）
- `ensureAuthorized()` 运行 OAuth 流程（浏览器 loopback），存储 refresh token
- `getAccessToken()` / `getRefreshToken()` 提供令牌，过期前自动刷新
- `logout()` 通过 `revokeToken(refreshToken)` 撤销服务端令牌后删除本地文件
- `colab drive-mount`（挂载命令）要求先 `drive-mount login`，未授权时报错退出

**挂载流程（`drive/mount.ts`）**：

```
driveMountCommand()
  → MountAuthManager.isAuthorized()（检查已登录，未登录报错退出）
  → 获取目标 runtime（--endpoint 或最新的）
  → DaemonClient.connect(serverId)
  → mountDrive(client, mountAuth)
      1. 获取 access token + refresh token
      2. 生成 Python 脚本（buildMountScript）
      3. 通过 daemon exec 执行

Python 脚本内部:
  1. 启动 HTTP server (`127.0.0.1` 随机端口) 模拟 metadata endpoint
     - /computeMetadata/v1/instance/service-accounts/default/token
       → 返回 { access_token, expires_in, token_type, scope }
     - /computeMetadata/v1/instance/service-accounts/default/email → 用户邮箱
     - /computeMetadata/v1/instance/service-accounts/default/scopes → scope 列表
     - 其他 GCE 路径 → 空 200 响应
  2. 令牌自动刷新：后台线程使用 refresh token 在过期前刷新 access token
  3. 杀死已有 DriveFS 进程
  4. 启动 `/opt/google/drive/drive --metadata_server_auth_uri=http://127.0.0.1:<port>/computeMetadata/v1`
  6. 轮询等待 /content/drive/My Drive 出现（最长 90 秒）
```

**关键细节**：
- DriveFS 要求 token 响应包含 `scope` 字段，否则报 "Received empty scopes" 并退出
- metadata server 由这段一次性 Python 脚本在 runtime 内启动，并通过 `--metadata_server_auth_uri=...` 直接传给当前 DriveFS 进程
- `drive.mount()` 在 Python 中调用时，先发 `blocking_request('request_auth')`，再检查 `os.path.isdir(mountpoint + '/My Drive')`。如果 auth 被旁路且挂载点仍存在，Colab 会打印 “Drive already mounted ...” 并直接返回

---

## 6. 与 colab-vscode 的差异

| 方面 | colab-vscode | colab-cli |
|---|---|---|
| HTTP client | `node-fetch` (v2, CJS) | 原生 `fetch` (Node 18+) |
| WebSocket | `@jupyterlab/services` 封装 | 直接 `ws` + 手动实现 Jupyter 线协议 |
| 连接管理 | VS Code Jupyter 扩展管理，WebSocket 由扩展框架维护 | 自建守护进程持有 WebSocket 长连接 |
| 认证存储 | VS Code SecretStorage | 文件 `~/.config/colab-cli/auth.json` (chmod 600) |
| 打开浏览器 | `vscode.env.openExternal` | `open` npm 包 |
| 事件系统 | `vscode.EventEmitter` | 无（直接调用） |
| 令牌刷新 | `SequentialTaskRunner` | 简单 `setTimeout` 链（守护进程内运行） |
| Keep-alive | 复杂的活跃度检测 + 用户提示 | 简单 `setInterval` 5 min（守护进程内运行） |
| Client Agent | `vscode` | `cli` |
| Zod 用法 | `z.enum(TypeScriptEnum)` | `z.nativeEnum()` / `z.enum(STRING_ARRAY)` |

### 为什么不用 `z.enum(TypeScriptEnum)`

colab-vscode 使用的 Zod 版本允许直接传 TS enum 对象给 `z.enum()`。但标准 Zod v3.23 的 `z.enum()` 只接受 `[string, ...string[]]`。解决方案：
- 字符串枚举：提取值为 `as const` 数组，如 `const VARIANTS = ['DEFAULT', 'GPU', 'TPU'] as const`
- 数值枚举：使用 `z.nativeEnum(Shape)`

---

## 7. 已知限制与待办

### 当前限制

1. **多 runtime**：虽然支持存储多个 server（每个 server 有独立的守护进程），但 `exec` 默认只用最新的一个。
2. **守护进程自动重连**：WebSocket 断开后守护进程直接退出，依赖下次 exec 自动重启。未实现进程内重连。
3. **并发 exec**：守护进程按 socket 连接串行处理请求。Jupyter kernel 本身也是串行执行，但多客户端同时连接时行为未定义。

### 开发路线

- [ ] `fs ls <path>`：列出 runtime 上指定路径的文件/目录。`GET /api/contents/<path>` 对目录会返回含 `content` 数组的响应（每项包含 `name`、`type`、`size`、`last_modified`）。`contents-client.ts` 的 `getContentsMetadata()` 已调用此端点，只需增加目录内容解析和表格格式化输出。参考：`colab-vscode/src/jupyter/contents/file-system.ts`（`readDirectory()`）
- [ ] `fs mkdir <path>`：在 runtime 上创建目录。`POST /api/contents/<path>` body `{ type: "directory" }`，Contents API 不要求父目录已存在。参考：`colab-vscode/src/jupyter/contents/file-system.ts`（`createDirectory()`）、`colab-vscode/src/jupyter/client/generated/apis/ContentsApi.ts`（`contentsCreate()`）
- [ ] `fs rm <path>`：删除 runtime 上的文件或目录。`DELETE /api/contents/<path>`，非空目录需先递归删除子项（参考 vscode 的 `deleteInternal()` 逻辑）或依赖服务端 `recursive` 参数支持。参考：`colab-vscode/src/jupyter/contents/file-system.ts`（`delete()` / `deleteInternal()`）
- [ ] `fs mv <old-path> <new-path>`：重命名/移动 runtime 上的文件或目录。`PATCH /api/contents/<old-path>` body `{ path: "<new-path>" }`，不需要额外复制或删除。参考：`colab-vscode/src/jupyter/contents/file-system.ts`（`rename()`）、`colab-vscode/src/jupyter/client/generated/apis/ContentsApi.ts`（`contentsRename()`）
- [x] `colab drive`：Google Drive 文件管理（list/upload/download/mkdir/delete/move）
- [x] 图片输出：守护进程内由 `image-saver.ts` 立即持久化到 `~/.config/colab-cli/outputs/<serverId>/`，`--output-dir` 可指定目录（CLI 端解析为绝对路径后传递给守护进程）；CLI 端 `terminal-renderer` 仅打印 savedPaths 路径
- [x] stdin 透传 + Ctrl+C 中断：拦截 `input_request` → readline/raw mode 获取用户输入 → `input_reply`；Ctrl+C → `interrupt` → kernel 中断 → 渲染 traceback
- [ ] 守护进程内 WebSocket 自动重连（替代退出 + 自动重启）
- [x] `--json` 输出模式（结构化输出）— 全局 `--json` flag，非 exec 命令通过 `createSpinner()` + `jsonResult()` 支持；登录命令（auth login / drive login / drive-mount login）在 `--json` 模式下非阻塞：输出 `auth_required` 事件（含 URL 和超时）后立即退出，后台守护进程等待 OAuth 回调完成凭证存储。`exec` 不支持 `--json`（打印警告并忽略），因为 exec 依赖交互式终端进行流式输出、stdin 透传和 Ctrl+C 中断
- [x] `colab drive-mount`：自动 Drive 挂载（伪 GCE metadata server + DriveFS，一次授权后免浏览器）
- [x] `runtime versions`：查看可用 runtime 版本及环境详情（Python、PyTorch 等），`runtime create --version` 指定版本
- [x] Ctrl+C 中断 kernel 执行：exec 期间 Ctrl+C → `client.interrupt()` → daemon → `POST /api/kernels/<id>/interrupt` → kernel 发回 KeyboardInterrupt traceback → CLI 渲染后正常退出；第二次 Ctrl+C force exit
- [x] `colab shell`（实验性）：在 runtime 上开启交互式 Shell。从 colab-vscode 移植 WebSocket 协议层（`/colab/tty`），通过 daemon 代理实现 bg/attach 模式。支持人类交互（raw mode）和 Agent 非阻塞模式（`-b` / `attach --no-wait` / `send`）。`Ctrl+\` detach，daemon 持有 WebSocket；`shell attach` 回放缓冲输出并恢复实时流。`shell send --data/--signal` 向 detached shell 注入原始字节或信号
- [ ] `runtime available` 补充不可用加速器信息：`GET /v1/user-info` 响应中已包含 `ineligibleAccelerators` 数组（与 `eligibleAccelerators` 并列），当前 `colab/api.ts` 的 Zod schema 已解析该字段但命令输出中未展示。可在 `runtime available` 输出末尾增加"因订阅等级不可用"列表，帮助用户了解升级路径。参考：`colab-vscode/src/colab/api.ts`（`UserInfo.ineligibleAccelerators: z.array(Accelerator)`）
- [ ] runtime 信息缓存/展示优化
- [ ] `daemon status` 命令：查看守护进程状态

---

## 8. 调试技巧

### 启用详细日志

```bash
./dist/index.js --verbose exec "print(1)"
```

`dist/index.js` 的 shebang 已内置 `node --use-env-proxy --disable-warning=UNDICI-EHPA`，因此直接执行可自动启用基于环境变量的代理支持。若显式使用 `node dist/index.js ...`，则不会经过 shebang，需要自行补上 `--use-env-proxy`。

`--verbose` 会输出 `[debug]` 和 `[trace]` 级别日志，包括：
- 守护进程启动/连接事件
- WebSocket 连接/断开事件
- 消息路由细节
- Keep-alive / token refresh 时间
- Ephemeral auth 流程

### 查看守护进程日志

```bash
# 日志文件位置
cat ~/.config/colab-cli/daemon-<server-id>.log

# 查看所有守护进程日志
ls -la ~/.config/colab-cli/daemon-*.log

# 实时跟踪
tail -f ~/.config/colab-cli/daemon-*.log
```

守护进程的 stdout/stderr 全部重定向到日志文件，包括：
- 内核连接/断开
- 令牌刷新
- 客户端连接/断开
- 错误和异常

### 检查存储文件

```bash
cat ~/.config/colab-cli/auth.json              # Colab 认证信息
cat ~/.config/colab-cli/servers.json            # runtime 列表
cat ~/.config/colab-cli/drive-auth.json         # Drive 认证信息
cat ~/.config/colab-cli/drive-mount-auth.json   # Drive 挂载认证信息（DriveFS）
```

### 检查守护进程状态

```bash
# 查看 PID 文件
cat ~/.config/colab-cli/daemon-<server-id>.pid

# 检查进程是否存在
ps -p $(cat ~/.config/colab-cli/daemon-<server-id>.pid)

# 手动停止守护进程
kill $(cat ~/.config/colab-cli/daemon-<server-id>.pid)
```

### 常见问题排查

**"Not logged in" 但确实登录过**
- 检查 `auth.json` 是否存在
- 可能 refresh token 已失效（`invalid_grant`），需要重新 `auth login`

**assign 失败 412**
- 已有太多 runtime，先 `runtime list` 然后 `runtime destroy`

**"Daemon failed to start within timeout"**
- 查看守护进程日志：`cat ~/.config/colab-cli/daemon-<server-id>.log`
- 常见原因：auth token 过期、server 记录已失效、网络问题
- 检查 proxy 环境变量是否正确（守护进程继承父进程的环境变量）
- 注意：守护进程 socket 在 kernel 连接完成 **之前** 就开始监听，因此 kernel 连接慢本身不会触发此错误。如果仍然出现，说明守护进程进程本身启动失败（auth/server 问题）

**exec 卡住无输出**
- 查看守护进程日志确认 WebSocket 是否仍然连接
- 用 `--verbose` 看守护进程连接和消息事件
- 可能代码执行本身耗时较长（大模型推理等）
- 如果是 `runtime create` 后立即 `exec`，属于正常等待：守护进程正在连接 kernel，exec 会在 kernel 就绪后自动开始执行

**"Daemon connection closed unexpectedly"**
- 守护进程已退出（可能非重启期间 WebSocket 意外断开触发健康检查退出）
- 重新执行 exec 会自动重启守护进程
- 如果出现在 `runtime restart` 期间，说明 `isRestarting` 标记逻辑可能有问题（正常情况下重启期间健康检查会跳过）

### 直接测试 Colab API

```bash
# 获取 access token（需要已登录）
TOKEN=$(node -e "
  import('./dist/auth/auth-manager.js').then(async m => {
    const a = new m.AuthManager();
    await a.initialize();
    console.log(await a.getAccessToken());
  })
")

# 列出 assignments
curl -H "Authorization: Bearer $TOKEN" \
     -H "Accept: application/json" \
     "https://colab.pa.googleapis.com/v1/assignments"
```

---

## 9. 构建与运行

```bash
cd /Users/justin/dev26/colab-runtime-2/colab-cli

npm install          # 安装依赖
npm run build        # TypeScript 编译到 dist/
npm run dev          # watch 模式编译

./dist/index.js --help         # 运行
./dist/index.js auth login     # 登录
./dist/index.js runtime create --accelerator H100 --shape high-ram
./dist/index.js exec "import torch; print(torch.cuda.is_available())"
./dist/index.js exec -f script.py          # 执行文件
```

### 命令总览

除 `exec` 外的所有命令支持全局 `--json` 标志，输出结构化 JSON Lines 到 stdout（适用于脚本自动化）。常规情况下最后一行是带 `command` 字段的结果对象。登录命令（auth login / drive login / drive-mount login）在 `--json` 模式下非阻塞：输出 `{"event":"auth_required","authType":"...","url":"...","timeoutSeconds":120}` 后立即退出，后台守护进程等待 OAuth 回调；调用方可通过对应的 `status --json` 命令轮询确认登录完成。命令级失败通常输出 `{"error":"..."}` 并以非零状态退出。`exec` 忽略 `--json`（打印警告），因为它依赖交互式终端进行流式输出、stdin 透传和 Ctrl+C 中断。

```text
auth login
auth status
auth logout
runtime available
runtime versions
runtime create --accelerator <name> [--shape <shape>] [-v <version>]
runtime list
runtime destroy [--endpoint <endpoint>]
runtime restart [--endpoint <endpoint>]
exec [code] [-f <file>] [-e <endpoint>] [-o <output-dir>]
fs upload <local-path> [-r <remote-path>] [-e <endpoint>]
fs download <remote-path> [-o <local-path>] [-e <endpoint>]
drive login
drive logout
drive status
drive list [folder-id]
drive upload <local-path> [-p <folder-id>]
drive download <file-id> [-o <path>]
drive mkdir <name> [-p <folder-id>]
drive delete <file-id> [--permanent]
drive move <item-id> --to <folder-id>
drive-mount                                          # 需要 COLAB_DRIVEFS 环境变量
drive-mount login
drive-mount logout
drive-mount status
```

### ESM 注意事项

- 所有内部 `import` 必须使用 `.js` 后缀（即使源文件是 `.ts`）
- `generated/` 目录下的文件已手动添加了 `.js` 后缀（原始生成代码没有）
- 如果重新生成 Jupyter client，需要再次添加 `.js` 后缀：
  ```bash
  find src/jupyter/client/generated -name '*.ts' \
    -exec sed -i '' "s/from '\(\.\.\/[^']*\)'/from '\1.js'/g" {} + \
    -exec sed -i '' "s/from '\(\.\/[^']*\)[^j][^s]'/from '\1.js'/g" {} +
  ```

---

## 10. 源码溯源

colab-cli 的协议层源自 colab-vscode 扩展。以下为关键对照：

| colab-cli 文件 | colab-vscode 源文件 | 改动程度 |
|---|---|---|
| `colab/api.ts` | `colab/api.ts` | 中等：去掉 GeneratedSession/Kernel 依赖，改 z.enum 为 z.nativeEnum |
| `colab/client.ts` | `colab/client.ts` | 中等：去掉 @traceMethod/telemetry/node-fetch，用原生 fetch |
| `colab/headers.ts` | `colab/headers.ts` | 微小：agent 值改为 `cli` |
| `utils/uuid.ts` | `utils/uuid.ts` | 无改动 |
| `auth/loopback-server.ts` | `common/loopback-server.ts` | 微小：去掉 vscode.Disposable |
| `auth/loopback-flow.ts` | `auth/flows/loopback.ts` | 大：重写，合并 CodeManager + flow 逻辑 |
| `auth/auth-manager.ts` | `auth/auth-provider.ts` | 大：重写，去掉 vscode.authentication API |
| `auth/ephemeral.ts` | `auth/ephemeral.ts` | 中等：前台 CLI 交互 + readline，`--json` 模式下将 prompt 路由到 stderr，并在非 TTY 时返回 `consent_required` |
| `jupyter/client/index.ts` | `jupyter/client/index.ts` | 中等：去掉 vscode.Uri/Event，简化为 kernels+sessions |
| `jupyter/client/generated/` | `jupyter/client/generated/` | 无改动（只加 .js 后缀） |
| `jupyter/kernel-connection.ts` | 无对应（stdin 部分参考 `jupyter-kernel-client/wsclient.py`） | **全新**：核心组件，实现 Jupyter 线协议。stdin 透传（`InputRequestOutput`、`sendStdinReply`）参考 jupyter-kernel-client 的 `execute_interactive` + `input()` + `_stdin_hook_default` |
| `runtime/runtime-manager.ts` | `jupyter/assignments.ts` | 大：简化，去掉事件系统，改为调度守护进程 |
| `runtime/keep-alive.ts` | `colab/keep-alive.ts` | 大：简化为 setInterval |
| `runtime/connection-refresher.ts` | `colab/connection-refresher.ts` | 大：简化为 setTimeout 链 |
| `output/terminal-renderer.ts` | 无对应 | **全新**：终端输出渲染（仅打印 savedPaths） |
| `output/json-output.ts` | 无对应 | **全新**：`--json` 模式全局状态、SilentSpinner、jsonResult/jsonError、`notifyAuthUrl()` |
| `daemon/*` | 无对应 | **全新**：守护进程架构，IPC 通信 |
| `daemon/image-saver.ts` | vscode-jupyter `plotSaveHandler.ts` | **新增**：图片 MIME 持久化，返回带 savedPaths 的 output |
| `jupyter/contents-client.ts` | `jupyter/client/generated/apis/ContentsApi.ts` | **重写**：手写 REST client，修复路径编码 |
| `transfer/common.ts` | 无对应 | **全新**：传输共享基础设施 |
| `transfer/upload.ts` | `colab-runtime-skill/runtime/src/upload.js` | **移植**：从 JS 移植为 TS，适配 ConnectionProvider |
| `transfer/download.ts` | `colab-vscode/src/jupyter/contents/file-system.ts` (readFile) | **全新**：参考 readFile 的 base64 GET，新增分块并发下载 |
| `commands/fs.ts` | 无对应 | **全新**：文件系统子命令 |
| `commands/drive-mount.ts` | 无对应 | **全新**：Drive 挂载子命令（login/logout/mount/status） |
| `drive/mount-auth.ts` | 无对应 | **全新**：DriveFS OAuth 凭据管理（环境变量驱动） |
| `drive/mount.ts` | 无对应 | **全新**：Drive 挂载执行（伪 GCE metadata server + DriveFS 启动脚本） |
| `terminal/terminal-connection.ts` | `colab/terminal/colab-terminal-websocket.ts` | **移植**：去掉 VS Code `Disposable`/事件系统，保留 WebSocket 连接逻辑（`wss://<proxy>/colab/tty`）、pending message queue、JSON 消息格式（`{"data":...}` / `{"cols":N,"rows":N}`）。复用 `getProxyAgent()` 和 `COLAB_RUNTIME_PROXY_TOKEN_HEADER` |
| `terminal/terminal-buffer.ts` | 无对应 | **全新**：有界环形缓冲区（默认 100KB），用于 daemon 侧缓存终端输出，支持 attach 时回放和 `--tail` 截取。Snapshot 模式下经 `renderForSnapshot()` 后处理（剥离 ANSI、折叠 `\r` 覆写），为非交互消费方提供干净输出 |
| `commands/shell.ts` | `colab/commands/terminal.ts` | **重写**：原始入口仅调用 `openTerminal()` 创建 VS Code 终端面板。CLI 版重新实现为 daemon IPC 模式：`shellCommand`（前台/后台）、`shellAttachCommand`（流式/快照）、`shellListCommand`、`shellSendCommand`、`runShellSession`（raw mode 交互循环） |
| `port-forward/token-refresher.ts` | `colab/connection-refresher.ts` | **参考**：定时刷新模式，去掉 `updateServerToken()` 持久化，新增 `port` 参数 |
| `port-forward/forwarder.ts` | 无对应 | **全新**：`http-proxy` 反向代理，注入 token header，HTTP + WebSocket |
| `port-forward/session.ts` | 无对应 | **全新**：组合 refresher + http.Server 管理转发生命周期 |
| `commands/port-forward.ts` | 无对应 | **全新**：`create`/`list`/`close` 子命令 + spec 解析 |

### 未实现功能的 colab-vscode 源码参考

以下功能在 colab-vscode 中已有完整实现，但 colab-cli 尚未移植。所有路径均相对于 `/Users/justin/dev26/colab-runtime-2/colab-vscode/src/`。

| 功能 | colab-vscode 源文件 | 关键类 / 方法 |
|---|---|---|
| ~~交互式终端 WebSocket~~ | ~~`colab/terminal/colab-terminal-websocket.ts`~~ | ~~已实现~~：移植为 `terminal/terminal-connection.ts`，通过 daemon 代理 WebSocket 连接 |
| ~~终端 PTY 仿真（输入/resize/输出）~~ | ~~`colab/terminal/colab-pseudoterminal.ts`~~ | ~~已实现~~：VS Code PTY 接口不适用于 CLI；改为 `commands/shell.ts` 的 `runShellSession()` 直接操作 `process.stdin` raw mode |
| ~~终端命令入口~~ | ~~`colab/commands/terminal.ts`~~ | ~~已实现~~：`commands/shell.ts` 提供 `shell` / `shell attach` / `shell list` / `shell send` 子命令 |
| ~~内核中断~~ | ~~`jupyter/client/generated/apis/KernelsApi.ts`~~ | ~~已实现~~：exec 期间 Ctrl+C → `client.interrupt()` → daemon → kernel interrupt |
| `fs ls`（列目录内容） | `jupyter/contents/file-system.ts` | `ColabFileSystem.readDirectory()` |
| `fs mkdir`（创建目录） | `jupyter/contents/file-system.ts` | `ColabFileSystem.createDirectory()` |
| `fs rm`（删除文件/目录，含递归） | `jupyter/contents/file-system.ts` | `ColabFileSystem.delete()` + `deleteInternal()` |
| `fs mv`（重命名/移动） | `jupyter/contents/file-system.ts` | `ColabFileSystem.rename()` |
| Contents API 操作（mkdir/delete/rename）| `jupyter/client/generated/apis/ContentsApi.ts` | `contentsCreate()` / `contentsDelete()` / `contentsRename()` |
| 不可用加速器信息 | `colab/api.ts` | `UserInfo.ineligibleAccelerators: z.array(Accelerator)` |

---

*最后更新：2026-03-28 实现 stdin 透传（input/getpass）+ Ctrl+C kernel 中断，新增 §4.5 含完整源码溯源*
