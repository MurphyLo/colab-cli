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
│   │   └── protocol.ts             # NDJSON IPC 消息类型定义
│   │
│   ├── colab/                       # Colab REST API 层
│   │   ├── api.ts                   # Zod schema + 类型定义
│   │   ├── client.ts                # ColabClient：assign/unassign/refresh/keepalive
│   │   └── headers.ts               # HTTP header 常量
│   │
│   ├── auth/                        # OAuth2 认证
│   │   ├── auth-manager.ts          # 令牌管理（刷新、存储、登录/登出）
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
│   │   ├── fs.ts                    # 文件系统操作：upload / download
│   │   ├── drive.ts                 # Drive 操作：login / logout / status / list / upload / download / mkdir / delete / move
│   │   └── drive-mount.ts           # Drive 挂载操作：login / logout / mount / status
│   │
│   ├── output/
│   │   ├── json-output.ts           # --json 模式：全局状态、SilentSpinner、jsonResult()
│   │   └── terminal-renderer.ts     # 将 Jupyter IOPub 消息渲染到终端
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

### 3.4 IPC 协议

CLI 与守护进程之间使用 **NDJSON**（Newline-Delimited JSON）通信。

**Client → Server**：

```jsonl
{"type": "exec", "code": "print('hello')"}
{"type": "auth_response", "requestId": "<uuid>", "error": "optional error"}
{"type": "interrupt"}
{"type": "restart"}
{"type": "ping"}
```

**Server → Client**：

```jsonl
{"type": "ready"}
{"type": "auth_required", "requestId": "<uuid>", "authType": "dfs_ephemeral"}
{"type": "output", "output": {"type": "stream", "name": "stdout", "text": "hello\n"}}
{"type": "exec_done"}
{"type": "exec_error", "message": "..."}
{"type": "restarted"}
{"type": "restart_error", "message": "..."}
{"type": "pong"}
```

**通信流程**：

1. CLI 连接 Unix Socket
2. 守护进程发送 `ready`
3. CLI 发送 `exec` 请求
4. 如果 kernel 在执行期间触发 `request_auth`（如 `drive.mount()`），守护进程发送 `auth_required`
5. CLI 前台进程负责浏览器/OAuth 交互，并回送 `auth_response`
6. 守护进程继续逐条发送 `output` 消息（流式）
7. 守护进程发送 `exec_done` 或 `exec_error`
8. CLI 断开（守护进程继续运行）

### 3.5 生命周期管理

| 事件 | 行为 |
|---|---|
| `runtime create` | `RuntimeManager.create()` 调用 `startDaemon(serverId)` |
| `exec` | `DaemonClient.connect()` 检测守护进程是否运行，未运行则自动 `startDaemon()` |
| `runtime restart` | 通过 IPC 发送 `restart` 命令，守护进程内部重启 kernel。重启期间 `KernelConnection.isRestarting` 为 `true`，健康检查会跳过 |
| `runtime destroy` | `RuntimeManager.destroy()` 调用 `stopDaemon(serverId)` (SIGTERM)，然后 unassign |
| 守护进程 WebSocket 断开 | 健康检查（30s 间隔）发现 `!isConnected && !isRestarting` 后自动退出，下次 exec 会重启 |
| 系统重启 | PID 文件残留，`isDaemonRunning()` 通过 `kill(pid, 0)` 检测到进程不存在，清理残留文件 |

### 3.6 KernelConnection 的动态 URL

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
      4. CLI 端渲染输出（流式或 --batch 模式）
      5. 如果任一 `KernelOutput` 的 `type === "error"`，CLI 在完成后设置 `process.exitCode = 1`
  → DaemonClient.close()

守护进程内部:
  KernelConnection.execute(code)
    1. 发送 execute_request 到 WebSocket shell channel
    2. 返回 AsyncGenerator<KernelOutput>
    3. 逐个 yield iopub 消息：stream, execute_result, display_data, error, status
    4. 完成条件：收到 execute_reply (shell) AND status:idle (iopub)
```

**消息完成条件**：execute_reply (shell channel) 可能先于 iopub 消息到达。因此必须等待 **两个** 信号都收到才标记执行完成：`gotExecuteReply && gotIdle`。

**图片输出处理**：`display_data` 和 `execute_result` 类型的 `KernelOutput` 可能包含图片 MIME 数据（如 `plt.show()` 产生的 `image/png`）。`saveImages()` 在所有模式（终端/batch/JSON）下统一处理：将图片写入文件，并**原地替换** `data[mime]` 为已保存的文件路径。终端模式额外打印 `[saved image/png → ...]` 提示；JSON 模式下 `jsonResult()` 输出中直接包含文件路径而非 base64，避免终端溢出。详见下方 §4.7。

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
3. 守护进程通过 Unix Socket 向前台 CLI 发送 `auth_required { requestId, authType }`
4. 前台 CLI 调用 `auth/ephemeral.ts`
   4.1 `propagateCredentials(endpoint, { authType, dryRun: true })`
   4.2 如果已授权 → 直接 `propagateCredentials(..., dryRun: false)`
   4.3 如果未授权 → 在终端提示用户，并以与 `auth login` 一致的格式打印 URL / 打开浏览器
       `--json` 模式下，说明文字和 readline prompt 走 stderr，stdout 额外发出 `{"event":"auth_required", ...}` 事件
   4.4 用户在浏览器完成 OAuth 后，前台 CLI 执行 `propagateCredentials(..., dryRun: false)`
5. 前台 CLI 通过 Unix Socket 回送 `auth_response { requestId, error? }`
6. 守护进程收到 `auth_response` 后，向 kernel 发送 `input_reply`
   content.value.type='colab_reply', content.value.colab_msg_id=<id>
```

**设计原因**：守护进程是 `detached` 后台进程，不能可靠地直接占用当前终端做交互，也不能在沙箱环境里稳定拉起本机 GUI 浏览器。因此 `drive.mount()` 的授权提示必须由前台 CLI 进程承接，守护进程只负责检测 kernel 的 `request_auth` 并转发。

**非交互 JSON 行为**：如果 `--json` 模式下 stdout 被脚本消费且 stdin 不是 TTY，前台 CLI 在需要用户完成浏览器授权时会抛出 `AuthConsentError`；CLI 入口统一转换为 `{"error":"consent_required","authType":"...","url":"..."}`，并以非零状态码退出，避免卡死在不可交互的 `readline` 上。

**本地 Drive 凭据旁路**：当 `MountAuthManager.isConfigured()` 且已授权时（即 DriveFS 环境变量已配置且 `drive-mount login` 已完成），`handleEphemeralAuth()` 对 `DFS_EPHEMERAL` 类型直接 return，跳过整个 `propagateCredentials` 流程。这使得 Python 代码中的 `drive.mount()` 无需浏览器交互——`blocking_request('request_auth')` 成功返回后，`drive.mount()` 检测到已存在的挂载点即刻完成。

### 4.5 内核重启

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

### 4.6 图片输出保存

当执行的代码产生图片输出（`plt.show()`、`IPython.display.Image()` 等）时，Jupyter kernel 通过 iopub 发送 `display_data` 或 `execute_result` 消息，其 `data` 字段包含多种 MIME 表示（如 `image/png` 的 base64 编码、`text/plain` 的文本回退）。

**核心函数 `saveImages()`**（`output/terminal-renderer.ts`）是唯一的图片持久化入口，终端模式和 JSON 模式共用：

```
saveImages(data: Record<string, string>)
  for each (mime, content) in data:
    1. 查找 imageExtensionForMimeType[mime] → ext（未命中则跳过）
    2. 递增全局 outputCounter → 生成文件路径 output-<n>.<ext>
    3. 写入文件：SVG 为 UTF-8 文本，其余 Buffer.from(base64)
    4. 原地替换 data[mime] = filePath
```

**保存目录策略**：

| 场景 | 目录 |
|------|------|
| 用户指定 `--output-dir ./plots` | `./plots/`（用户自行管理覆盖） |
| 未指定（默认） | `~/.config/colab-cli/outputs/<ISO-timestamp>/`（每次 exec 隔离） |

每次 `execCommand()` 入口调用 `setOutputDir()` 重置 counter 和目录。

**各模式的调用路径**：

- **终端（流式/batch）**：`renderOutput()` → `saveImages()` + `printSavedPaths()`（打印 `[saved ...]` 到 stdout）
- **JSON**：`exec.ts` 循环中直接调用 `saveImages()`，替换后的路径随 `jsonResult()` 输出

**源码溯源**：

| 逻辑 | 来源 | 原始位置 |
|------|------|----------|
| MIME→扩展名映射 (`image/png` → `png` 等) | vscode-jupyter | `src/webviews/extension-side/plotView/plotSaveHandler.ts:14-18` (`imageExtensionForMimeType`) |
| `data` 字段包含所有 MIME 类型（base64 图片 + text/plain 回退） | jupyter-kernel-client | `jupyter_kernel_client/client.py:24-105` (`output_hook()`)，`data: content.get("data")` 原样透传 |
| SVG 为原始文本、二进制图片为 base64 | Jupyter wire protocol | [Jupyter messaging spec: display_data](https://jupyter-client.readthedocs.io/en/stable/messaging.html#display-data) |
| `Buffer.from(base64)` 写入文件 | vscode-jupyter | `plotSaveHandler.ts:88` (`fs.writeFile(target, data.data)`)，colab-cli 使用 Node.js `Buffer` 等价实现 |

**竞态防护**：步骤 1-4 期间 `isConnected` 为 `false`，但 `isRestarting` 为 `true`。守护进程健康检查条件为 `!isConnected && !isRestarting`，因此不会在重启窗口内误杀守护进程。

### 4.6 文件传输流程

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
| `listFiles(token, parentId?, pageToken?)` | 列出文件夹内容（100 项/页，按 folder+name 排序） |
| `getFileMetadata(token, fileId)` | 获取单个文件元数据（含 md5Checksum） |
| `downloadFile(token, fileId, destPath)` | 流式下载到本地 |
| `createFolder(token, name, parentId?)` | 创建文件夹 |
| `trashFile(token, fileId)` | 移至回收站 |
| `permanentlyDelete(token, fileId)` | 永久删除 |
| `moveDriveItem(token, itemId, newParentId)` | 移动 Drive 项（文件或文件夹，PATCH addParents/removeParents） |
| `findFileByName(token, fileName, parentId)` | 按名称查找文件（用于 MD5 去重） |

**所有参数均使用 raw ID**：Google Drive 允许同一文件夹内存在同名文件/文件夹，因此基于名称/路径的解析不稳健。所有命令的文件/文件夹参数统一使用 Drive file ID，用户通过 `list` 获取 ID。未指定父文件夹时默认为 `root`。

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
  1. 启动 HTTP server (0.0.0.0:8009) 模拟 GCE metadata endpoint
     - /computeMetadata/v1/instance/service-accounts/default/token
       → 返回 { access_token, expires_in, token_type, scope }
     - /computeMetadata/v1/instance/service-accounts/default/email → 用户邮箱
     - /computeMetadata/v1/instance/service-accounts/default/scopes → scope 列表
     - 其他 GCE 路径 → 空 200 响应
  2. 令牌自动刷新：后台线程使用 refresh token 在过期前刷新 access token
  3. 杀死已有 DriveFS 进程
  4. 设置 TBE_EPHEM_CREDS_ADDR=172.28.0.1:8009
  5. 启动 /opt/google/drive/drive --metadata_server_auth_uri=...
  6. 轮询等待 /content/drive/My Drive 出现（最长 90 秒）
```

**关键细节**：
- DriveFS 要求 token 响应包含 `scope` 字段，否则报 "Received empty scopes" 并退出
- metadata server 必须监听 `0.0.0.0:8009`（DriveFS 硬编码通过 `TBE_EPHEM_CREDS_ADDR` 访问 `172.28.0.1:8009`）
- `drive.mount()` 在 Python 中调用时，先发 `blocking_request('request_auth')`，再检查 `os.path.isdir(mountpoint + '/My Drive')`。pre-mount 后两步均快速通过（auth 被旁路，挂载点已存在）

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
2. **stdin 支持**：通用的 Python `input()` / `input_request` 透传尚未实现。
   例外：Colab 自定义的 `request_auth`（`drive.mount()` / 临时 Google 凭据传播）已经通过 `auth_required` / `auth_response` 专门支持。
3. **守护进程自动重连**：WebSocket 断开后守护进程直接退出，依赖下次 exec 自动重启。未实现进程内重连。
4. **并发 exec**：守护进程按 socket 连接串行处理请求。Jupyter kernel 本身也是串行执行，但多客户端同时连接时行为未定义。

### 开发路线

- [ ] `fs ls <path>`：列出 runtime 上指定路径的文件/目录。`GET /api/contents/<path>` 对目录会返回含 `content` 数组的响应（每项包含 `name`、`type`、`size`、`last_modified`）。`contents-client.ts` 的 `getContentsMetadata()` 已调用此端点，只需增加目录内容解析和表格格式化输出。参考：`colab-vscode/src/jupyter/contents/file-system.ts`（`readDirectory()`）
- [ ] `fs mkdir <path>`：在 runtime 上创建目录。`POST /api/contents/<path>` body `{ type: "directory" }`，Contents API 不要求父目录已存在。参考：`colab-vscode/src/jupyter/contents/file-system.ts`（`createDirectory()`）、`colab-vscode/src/jupyter/client/generated/apis/ContentsApi.ts`（`contentsCreate()`）
- [ ] `fs rm <path>`：删除 runtime 上的文件或目录。`DELETE /api/contents/<path>`，非空目录需先递归删除子项（参考 vscode 的 `deleteInternal()` 逻辑）或依赖服务端 `recursive` 参数支持。参考：`colab-vscode/src/jupyter/contents/file-system.ts`（`delete()` / `deleteInternal()`）
- [ ] `fs mv <old-path> <new-path>`：重命名/移动 runtime 上的文件或目录。`PATCH /api/contents/<old-path>` body `{ path: "<new-path>" }`，不需要额外复制或删除。参考：`colab-vscode/src/jupyter/contents/file-system.ts`（`rename()`）、`colab-vscode/src/jupyter/client/generated/apis/ContentsApi.ts`（`contentsRename()`）
- [x] `colab drive`：Google Drive 文件管理（list/upload/download/mkdir/delete/move）
- [x] 图片输出：自动保存到 `~/.config/colab-cli/outputs/<timestamp>/`，`--output-dir` 可指定目录；终端和 JSON 模式共用 `saveImages()`
- [ ] stdin 透传：拦截 `input_request` 消息并转发到 `readline`
- [ ] 守护进程内 WebSocket 自动重连（替代退出 + 自动重启）
- [x] `--json` 输出模式（结构化输出）— 全局 `--json` flag，所有命令通过 `createSpinner()` + `jsonResult()` 支持；OAuth URL 通过 `auth_required` JSON event 暴露，人类可读提示走 stderr
- [x] `colab drive-mount`：自动 Drive 挂载（伪 GCE metadata server + DriveFS，一次授权后免浏览器）
- [x] `runtime versions`：查看可用 runtime 版本及环境详情（Python、PyTorch 等），`runtime create --version` 指定版本
- [ ] `colab exec --interrupt`（或独立的 `colab runtime interrupt` 命令）：中断正在运行的 Python 代码。守护进程 IPC 协议（`daemon/protocol.ts`）已定义 `{"type": "interrupt"}` 消息类型，需在 `exec.ts` 中发送该消息，并在 `daemon/server.ts` 中调用 `POST /api/kernels/<kernel_id>/interrupt`。colab-cli 已有的生成代码 `jupyter/client/generated/apis/KernelsApi.ts` 中 `KernelsApi.interrupt()` 方法可直接使用。参考：`colab-vscode/src/jupyter/client/generated/apis/KernelsApi.ts`（`KernelsApi.interrupt()` → `POST /api/kernels/{id}/interrupt`）
- [ ] `colab terminal`（实验性）：在 runtime 上开启交互式 Shell。协议层已完全在 colab-vscode 中验证：WebSocket 连接 `wss://<proxy-url>/colab/tty`（需带 `X-Colab-Runtime-Proxy-Token` header），双向传输 JSON 消息——发送方向：`{ data: string }`（键盘输入）和 `{ cols: number, rows: number }`（窗口 resize）；接收方向：`{ data: string }`（终端输出）。CLI 侧需配合 `node-pty` 或直接操作 `process.stdin`/`stdout` raw mode 实现本地终端。参考：`colab-vscode/src/colab/terminal/colab-terminal-websocket.ts`（`ColabTerminalWebSocket`）、`colab-vscode/src/colab/terminal/colab-pseudoterminal.ts`（`ColabPseudoTerminal`）、`colab-vscode/src/colab/commands/terminal.ts`
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
./dist/index.js exec -b "print('hello')"   # --batch 模式（收集所有输出后一次性打印）
```

### 命令总览

所有命令支持全局 `--json` 标志，输出结构化 JSON Lines 到 stdout（适用于脚本自动化）。常规情况下最后一行是带 `command` 字段的结果对象；若流程中需要浏览器 OAuth，则可能先输出一行 `{"event":"auth_required", ...}`。命令级失败通常输出 `{"error":"..."}` 并以非零状态退出；`exec` 另有一个特例：如果 kernel 返回 `error` 输出，最终仍输出 `{"command":"exec","outputs":[...],"error":true}`，同时进程以非零状态退出。

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
exec [code] [-f <file>] [-e <endpoint>] [-b|--batch]
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
| `jupyter/kernel-connection.ts` | 无对应 | **全新**：核心组件，实现 Jupyter 线协议 |
| `runtime/runtime-manager.ts` | `jupyter/assignments.ts` | 大：简化，去掉事件系统，改为调度守护进程 |
| `runtime/keep-alive.ts` | `colab/keep-alive.ts` | 大：简化为 setInterval |
| `runtime/connection-refresher.ts` | `colab/connection-refresher.ts` | 大：简化为 setTimeout 链 |
| `output/terminal-renderer.ts` | 无对应 | **全新**：终端输出渲染 |
| `output/json-output.ts` | 无对应 | **全新**：`--json` 模式全局状态、SilentSpinner、jsonResult/jsonError、`notifyAuthUrl()` |
| `daemon/*` | 无对应 | **全新**：守护进程架构，IPC 通信 |
| `jupyter/contents-client.ts` | `jupyter/client/generated/apis/ContentsApi.ts` | **重写**：手写 REST client，修复路径编码 |
| `transfer/common.ts` | 无对应 | **全新**：传输共享基础设施 |
| `transfer/upload.ts` | `colab-runtime-skill/runtime/src/upload.js` | **移植**：从 JS 移植为 TS，适配 ConnectionProvider |
| `transfer/download.ts` | `colab-vscode/src/jupyter/contents/file-system.ts` (readFile) | **全新**：参考 readFile 的 base64 GET，新增分块并发下载 |
| `commands/fs.ts` | 无对应 | **全新**：文件系统子命令 |
| `commands/drive-mount.ts` | 无对应 | **全新**：Drive 挂载子命令（login/logout/mount/status） |
| `drive/mount-auth.ts` | 无对应 | **全新**：DriveFS OAuth 凭据管理（环境变量驱动） |
| `drive/mount.ts` | 无对应 | **全新**：Drive 挂载执行（伪 GCE metadata server + DriveFS 启动脚本） |

### 未实现功能的 colab-vscode 源码参考

以下功能在 colab-vscode 中已有完整实现，但 colab-cli 尚未移植。所有路径均相对于 `/Users/justin/dev26/colab-runtime-2/colab-vscode/src/`。

| 功能 | colab-vscode 源文件 | 关键类 / 方法 |
|---|---|---|
| 交互式终端 WebSocket | `colab/terminal/colab-terminal-websocket.ts` | `ColabTerminalWebSocket` → `wss://<proxy>/colab/tty` |
| 终端 PTY 仿真（输入/resize/输出） | `colab/terminal/colab-pseudoterminal.ts` | `ColabPseudoTerminal` |
| 终端命令入口 | `colab/commands/terminal.ts` | `openTerminal()` |
| 内核中断 | `jupyter/client/generated/apis/KernelsApi.ts` | `KernelsApi.interrupt()` → `POST /api/kernels/{id}/interrupt` |
| `fs ls`（列目录内容） | `jupyter/contents/file-system.ts` | `ColabFileSystem.readDirectory()` |
| `fs mkdir`（创建目录） | `jupyter/contents/file-system.ts` | `ColabFileSystem.createDirectory()` |
| `fs rm`（删除文件/目录，含递归） | `jupyter/contents/file-system.ts` | `ColabFileSystem.delete()` + `deleteInternal()` |
| `fs mv`（重命名/移动） | `jupyter/contents/file-system.ts` | `ColabFileSystem.rename()` |
| Contents API 操作（mkdir/delete/rename）| `jupyter/client/generated/apis/ContentsApi.ts` | `contentsCreate()` / `contentsDelete()` / `contentsRename()` |
| 不可用加速器信息 | `colab/api.ts` | `UserInfo.ineligibleAccelerators: z.array(Accelerator)` |

---

*最后更新：2026-03-24 补充 colab-vscode 未移植功能清单（`fs ls/mkdir/rm/mv`、内核中断、交互式终端、不可用加速器展示）及 colab-vscode 源码参考表*
