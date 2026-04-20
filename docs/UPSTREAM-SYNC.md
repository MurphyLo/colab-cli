# colab-vscode 上游跟踪

本文档跟踪 colab-cli 对 colab-vscode 上游实现的同步状态。每次审查后记录基准 commit、需要同步的变更、以及已完成的同步操作。

上游仓库本地路径：`/Users/justin/dev26/colab-runtime-2/colab-vscode`

---

## 当前基准

| 项 | 值 |
|---|---|
| 基准 commit | `38d41a5` fix: only attempt to recover from auth errors once (#493) |
| 基准日期 | 2026-03-17 |
| 审查日期 | 2026-04-20 |
| 上游 HEAD | `8319ccc` refactor: increase OAuth sign-in screen wait timeout (#565) |

---

## 待同步变更

（当前无待同步变更）

---

## 不影响 colab-cli 的变更

以下变更经审查确认无需同步（VS Code 特有功能、纯 build/CI/test、或 colab-cli 已有不同实现）：

| commit | 说明 | 跳过原因 |
|---|---|---|
| `b135a6c` refactor: client middleware (#505) | `ColabClient` 改为 middleware chain 架构 | colab-cli 用原生 fetch，架构不同 |
| `b13a5ce` feat: additional scopes to auth provider (#486) | incremental auth（`includeGrantedScopes`/`loginHint`） | CLI 一次性授权，暂不需要 |
| `e301bd1` fix: update drive scopes (#498) | Drive scope 改为 `drive.file` | colab-cli 用独立 OAuth client + `drive` 全权限 |
| `3ec9ea6` feat: add DriveClient (#503) | 裸 fetch 实现的 Drive client | colab-cli 已有 `googleapis` 包的实现 |
| `3735364` fix: unassign order (#525) | 先删 sessions 再 unassign | VS Code 特有状态管理 |
| `f24e86e` fix: revoke managed connections (#559) | `return` → `continue` 修复 | VS Code `JupyterConnectionManager` 特有 |
| `a54b347` fix: sort scopes (#517) | 排序 scopes | VS Code auth provider 特有 |
| `9e53188` fix: server not found event (#548) | provider 事件处理 | VS Code provider 特有 |
| `5e3de6a` fix: log process errors (#543) | extension 错误日志 | VS Code extension 特有 |
| `29c2542` feat: ConsumptionPoller (#530) | 消费轮询响应 assignment 变化 | VS Code UI 特有 |
| `b690ccc` feat: consumption status bar (#524) | 消费信息状态栏 | VS Code UI 特有 |
| `557d2e2` feat: enable terminal by default (#521) | package.json 开关 | VS Code 配置 |
| `92ddc04` feat: import notebook from URL (#463) | notebook 导入命令 | VS Code 命令 |
| `fbdfe57` feat: import deep-linking (#519) | URI handler 深度链接 | VS Code 特有 |
| `881d921` refactor: ExperimentStateProvider (#540) | 使用 SequentialTaskRunner | VS Code 特有 |
| `93d98e3` refactor: ResourceTreeProvider.getChildren (#523) | LatestCancelable | VS Code tree view |
| `cbb25b2` fix: guard disposed access (#514) | VS Code Disposable 生命周期 | VS Code 特有 |
| `9a075c1` refactor: resource error handling (#512) | 资源监控错误处理 | VS Code 特有 |
| `c24df57` / `f7bb8eb` / `3c0ddb5` / `1a2db3a` / `a5822a4` | ResourceTreeProvider 系列 | VS Code tree view |
| `8319ccc` refactor: OAuth timeout (#565) | e2e 测试超时 | 测试 |
| build/CI/deps/chore commits | 版本号、依赖升级、lint 配置等 | 无功能影响 |

---

## 已完成的同步

### 2026-04-20 同步 `98163e2` fix: amend free usage info API response (#547)

- 修改文件：`src/colab/api.ts`、`src/commands/usage.ts`
- `remainingTokens` 和 `nextRefillTimestampSec` 加 `.optional()`，schema transform 处理 undefined
- `usage.ts` 所有访问点加 nullish 保护

### 2026-04-20 同步 `6d599b3` feat: fallback to available accelerator(s) (#511)（仅 503 检测）

- 修改文件：`src/colab/client.ts`
- 新增 `AcceleratorUnavailableError` 错误类
- `assign()` 方法捕获 503 响应并抛出 `AcceleratorUnavailableError`
- 未实现加速器自动回退逻辑

### 2026-04-20 同步 `ae8ab3c` + `a5822a4` feat/refactor: resource monitoring API (#494, #504)

- 修改文件：`src/colab/api.ts`、`src/colab/client.ts`、`src/commands/runtime.ts`、`src/index.ts`
- 新增 `MemorySchema`、`GpuInfoSchema`、`FilesystemSchema`、`DiskSchema`、`ResourcesSchema` 及对应类型
- 新增 `getResources(proxyUrl, token)` 方法
- 新增 `colab runtime resources` 命令，展示 RAM / 磁盘 / GPU 使用情况

<!-- 模板：
### YYYY-MM-DD 同步 `<commit>` <title>

- 修改文件：...
- colab-cli commit：`<hash>`
- 备注：...
-->
