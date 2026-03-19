# colab-cli 开发文档

> 本文档记录 colab-cli 的技术细节，服务于后续开发与调试。
> **请在开发和 debug 过程中持续更新本文档**——修复 bug 时补充踩坑记录，新增功能时更新架构说明，发现协议细节时补充到对应章节。

---

## 1. 项目概览

colab-cli 是一个终端工具，无需 VS Code 或 notebook UI，直接通过命令行与 Google Colab GPU runtime 交互。

核心能力：OAuth 登录 → 创建/销毁 runtime → 通过后台守护进程维持 WebSocket 长连接 → 执行 Python 代码并流式输出结果。

### 技术栈

| 项 | 选型 | 说明 |
|---|---|---|
| 语言 | TypeScript 5.4+ | strict mode |
| 模块 | ESM (`"type": "module"`) | 所有内部 import 必须带 `.js` 后缀 |
| 运行时 | Node.js ≥ 18 | 使用原生 `fetch`、`crypto.randomUUID` |
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
│   ├── commands/                    # CLI 命令实现
│   │   ├── auth.ts                  # login / status / logout
│   │   ├── runtime.ts               # create / list / destroy / restart
│   │   ├── exec.ts                  # 代码执行（通过守护进程）
│   │   └── fs.ts                    # 文件系统操作：upload / download
│   │
│   ├── output/
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
{"type": "interrupt"}
{"type": "restart"}
{"type": "ping"}
```

**Server → Client**：

```jsonl
{"type": "ready"}
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
4. 守护进程逐条发送 `output` 消息（流式）
5. 守护进程发送 `exec_done` 或 `exec_error`
6. CLI 断开（守护进程继续运行）

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
  → colabClient.assign(randomUUID, { variant, accelerator, shape })
      内部两步：
      1. GET /tun/m/assign?nbh=<hash>&variant=GPU → 返回 xsrfToken（或已有 assignment）
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
  → DaemonClient.close()

守护进程内部:
  KernelConnection.execute(code)
    1. 发送 execute_request 到 WebSocket shell channel
    2. 返回 AsyncGenerator<KernelOutput>
    3. 逐个 yield iopub 消息：stream, execute_result, display_data, error, status
    4. 完成条件：收到 execute_reply (shell) AND status:idle (iopub)
```

**消息完成条件**：execute_reply (shell channel) 可能先于 iopub 消息到达。因此必须等待 **两个** 信号都收到才标记执行完成：`gotExecuteReply && gotIdle`。

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
3. 调用 ColabClient.propagateCredentials(endpoint, { authType, dryRun: true })
4. 如果已授权 → 直接 propagate (dryRun: false)
5. 如果未授权 → 提示用户在浏览器中完成授权 → 再 propagate
6. 发送 input_reply (content.value.type='colab_reply', content.value.colab_msg_id=<id>)
```

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

## 5. 与 colab-vscode 的差异

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

## 6. 已知限制与待办

### 当前限制

1. **图片输出**：`display_data` 中的 `image/png` 只打印占位符，未实现保存到文件。
2. **多 runtime**：虽然支持存储多个 server（每个 server 有独立的守护进程），但 `exec` 默认只用最新的一个。
3. **stdin 支持**：Python 的 `input()` 函数的 stdin 请求尚未实现转发到终端。
4. **守护进程自动重连**：WebSocket 断开后守护进程直接退出，依赖下次 exec 自动重启。未实现进程内重连。
5. **并发 exec**：守护进程按 socket 连接串行处理请求。Jupyter kernel 本身也是串行执行，但多客户端同时连接时行为未定义。

### 开发路线

- [ ] `fs ls` / `fs rm`：远程文件列表和删除
- [ ] `fs upload/download` > 500 MiB：Google Drive 传输通道
- [ ] 图片输出：`--output-dir` 参数，自动保存 PNG 到指定目录
- [ ] stdin 透传：拦截 `input_request` 消息并转发到 `readline`
- [ ] 守护进程内 WebSocket 自动重连（替代退出 + 自动重启）
- [ ] `--json` 输出模式（结构化输出）
- [ ] runtime 信息缓存/展示优化
- [ ] `daemon status` 命令：查看守护进程状态

---

## 7. 调试技巧

### 启用详细日志

```bash
node --use-env-proxy dist/index.js --verbose exec "print(1)"
```

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
cat ~/.config/colab-cli/auth.json    # 认证信息
cat ~/.config/colab-cli/servers.json  # runtime 列表
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

## 8. 构建与运行

```bash
cd /Users/justin/dev26/colab-runtime-2/colab-cli

npm install          # 安装依赖
npm run build        # TypeScript 编译到 dist/
npm run dev          # watch 模式编译

node dist/index.js --help         # 运行
node dist/index.js auth login     # 登录
node dist/index.js runtime create --accelerator H100 --shape highmem
node dist/index.js exec "import torch; print(torch.cuda.is_available())"
node dist/index.js exec -f script.py          # 执行文件
node dist/index.js exec -b "print('hello')"   # --batch 模式（收集所有输出后一次性打印）
```

### 命令总览

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
fs upload <local-path> [-r <remote-path>] [-e <endpoint>]
fs download <remote-path> [-o <local-path>] [-e <endpoint>]
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

## 9. 源码溯源

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
| `auth/ephemeral.ts` | `auth/ephemeral.ts` | 中等：用 readline 替代 vscode.window |
| `jupyter/client/index.ts` | `jupyter/client/index.ts` | 中等：去掉 vscode.Uri/Event，简化为 kernels+sessions |
| `jupyter/client/generated/` | `jupyter/client/generated/` | 无改动（只加 .js 后缀） |
| `jupyter/kernel-connection.ts` | 无对应 | **全新**：核心组件，实现 Jupyter 线协议 |
| `runtime/runtime-manager.ts` | `jupyter/assignments.ts` | 大：简化，去掉事件系统，改为调度守护进程 |
| `runtime/keep-alive.ts` | `colab/keep-alive.ts` | 大：简化为 setInterval |
| `runtime/connection-refresher.ts` | `colab/connection-refresher.ts` | 大：简化为 setTimeout 链 |
| `output/terminal-renderer.ts` | 无对应 | **全新**：终端输出渲染 |
| `daemon/*` | 无对应 | **全新**：守护进程架构，IPC 通信 |
| `jupyter/contents-client.ts` | `jupyter/client/generated/apis/ContentsApi.ts` | **重写**：手写 REST client，修复路径编码 |
| `transfer/common.ts` | 无对应 | **全新**：传输共享基础设施 |
| `transfer/upload.ts` | `colab-runtime-skill/runtime/src/upload.js` | **移植**：从 JS 移植为 TS，适配 ConnectionProvider |
| `transfer/download.ts` | `colab-vscode/src/jupyter/contents/file-system.ts` (readFile) | **全新**：参考 readFile 的 base64 GET，新增分块并发下载 |
| `commands/fs.ts` | 无对应 | **全新**：文件系统子命令 |

---

*最后更新：2026-03-19 新增文件传输功能（fs upload/download），支持分块并发*
