# Python 执行恢复：内核日志与双通道补读

## 决策与原因

采用 Python 内核 `Session.send/recv` 实例钩子，在发消息前记录带序号的完整
消息；WebSocket 提供实时流，Contents API 提供重放。无需独立远端进程、端口
或服务。原生 execute_request 保留变量、表达式、富输出、异常及交互行为。

真实断网曾在 daemon 不重启时丢失 63/240 条输出。控制实验确认服务端原生缓存
只覆盖其察觉断线之后的消息，不能补回此前发往失效链路的输出及完成信号。
因此保留同 session 重连仍有必要，但不能作为唯一恢复机制。

## 不变量

- 安装钩子并确认成功后才允许提交用户代码；不自动降级 Python 新任务。
- 每个执行有独立单调 seq；完整写入并 fsync 后才发送。写失败显式标记，不跳号。
- 实时与回读都通过同一排序入口；输出/协议状态和游标一起 checkpoint。
- 按序消费原请求 execute_reply 与 idle 才完成；不以全局 idle 或不存在日志推断成功、失败或“从未执行”。
- 代码只发送一次。丢失的提交确认、旧记录缺少日志等情况保留不确定，不能重跑。
- 输入回复只记录消息 ID 的接收确认，不记录密码或值。不确定的回复拒绝再次发送；收到确认不代表用户代码已经成功消费。
- 本地终态持久化后才能删除对应远端日志；清理失败保留，无未确认日志 TTL。

## 范围与限制

本机网络中断、CLI 退出、本地 daemon 重启可以依赖远端日志补齐；runtime
销毁、用户篡改钩子/日志、内核崩溃、磁盘失效不属于透明网络恢复。
日志丢失或损坏不得被包装成成功。只支持新 Python 执行；R、Julia 和旧执行
保持旧路径。shell 与整次 fs 传输的编排不变，fs 的 Python 执行步骤受益。

日志分段约 1 MiB，一条大消息可超过此值；巡检为三秒一次，单个 HTTP 请求
十秒超时。仍需关注 fsync 与大量消息的开销，不能宣称任意资源压力下无损。
远端钩子采用运行时 Python API，Colab 升级后的兼容性必须经实机回归确认。
二进制 buffers 保存于远端日志；CLI 展示仍遵循已有 KernelOutput 支持范围。

## 代码与验证

- `src/jupyter/kernel-journal.ts`：钩子、分段日志解析、HTTP 补读和清理。
- `src/jupyter/kernel-connection.ts`：安装确认、连续游标、实时/HTTP 合并、恢复与输入确认。
- `src/daemon/execution-store.ts`：进度状态恢复；终态持久化后由 server 调用清理。
- `tests/kernel-journal.test.mjs`：缺口、终态丢失、乱序重复、输入/授权、损坏、游标接管。
- `tests/live/kernel-journal.mjs`：显式 opt-in 的真实 Colab 独立内核测试。

部署必须重启空闲本地 daemon，旧运行任务不能追溯获得日志。
操作与故障边界详见 `docs/NETWORK-RECOVERY.md`。
