# 会话生命周期与 Hook

Bridge 负责逻辑会话的存续、Agent thread 绑定和执行调度。Hook 提供通用的会话准备与结束接口；Git、worktree、容器或临时目录的具体操作由 profile 所配置的外部脚本拥有。

## 配置

配置位于 `<channel-home>/config.json` 的 `profiles.<profile>`。Web 设置页与飞书 `/config` 均支持修改；`/status` 展示有效的自动重置配置及 Hook 是否启用。

```json
{
  "preferences": {
    "sessionAutoResetMinutes": 15,
    "maxConcurrentRuns": 1
  },
  "hooks": {
    "beforeSessionStart": {
      "command": "/usr/bin/python3",
      "args": ["/srv/qa/hooks/session.py"],
      "cwd": "/srv/qa/repository",
      "timeoutMs": 300000
    },
    "afterSessionEnd": {
      "command": "/usr/bin/python3",
      "args": ["/srv/qa/hooks/session.py"],
      "cwd": "/srv/qa/repository",
      "timeoutMs": 60000
    }
  }
}
```

`sessionAutoResetMinutes` 默认 15，0 关闭，接受 0–525600 的整数。它从上一轮完成计算；已收到且正在排队的请求不会仅因队列等待而过期。已有 `runIdleTimeoutMinutes` 是独立的运行探活设置。

Hook 直接执行 `command` 与 `args`，不经过隐式 shell。需要 shell 时显式指定解释器。`cwd` 可省略，默认使用 profile/会话所请求的基础 workspace；显式值必须为绝对路径。它与 Hook 返回给 Agent 的工作目录分别管理。`timeoutMs` 默认 120000，接受 1–3600000 的整数。配置 Hook 的 profile 当前要求 `maxConcurrentRuns=1`，让准备与整轮 Agent 执行共用同一个执行名额。

## 事件与协议

`beforeSessionStart` 在新逻辑会话首次启动 AI 前执行，普通续聊跳过。`afterSessionEnd` 在会话终结且没有活动任务、子进程或排队引用后执行。Agent 进程的一次正常退出不是逻辑会话结束。Bridge 普通停止或重启也不结束仍然有效的会话。

脚本从 stdin 接收一份 JSON：

```json
{
  "event": "beforeSessionStart",
  "sessionId": "bridge 分配的稳定 UUID",
  "profile": "qa",
  "scopeId": "chat 或 topic scope",
  "agentId": "codex",
  "reason": "new_session",
  "workspace": "/srv/qa",
  "state": null
}
```

结束原因包括 `idle_timeout`、`manual_reset`、`session_replaced`、`prepare_failed` 和 `prepare_interrupted`。Bridge session ID 与 Agent 后来建立的 thread/session ID 不同。脚本以 bridge session ID 为幂等键；进程崩溃或失败恢复可能使同一事件重试，外部副作用不承诺严格只执行一次。

可选的结构化结果写入环境变量 `LARK_HOOK_RESULT_FILE` 指向的文件，而 stdout/stderr 仅作为日志收集。未写结果文件等价于不覆盖目录和 state；无效结果或大于 64KiB 的结果明确失败。

```json
{
  "cwd": "/srv/qa/sessions/会话UUID",
  "state": { "projectOwnedResource": "opaque-value" }
}
```

结果 `cwd` 必须为绝对路径，Bridge 在启动 AI 前再次验证。新目录在后续轮次保持不变。`state` 可以是 JSON 值，Bridge 原样持久化并传给 `afterSessionEnd`，不解释其中的项目字段。结束 Hook 收到的 `workspace` 是该会话实际工作目录；其进程 cwd 仍遵循 Hook 配置/基础 workspace，允许资源已经被删除后的幂等重试。

同时提供 `LARK_HOOK_SESSION_ID`、`LARK_HOOK_EVENT`、`LARK_HOOK_SCOPE`、`LARK_HOOK_AGENT` 和 `LARK_HOOK_WORKSPACE`，便于简单脚本使用。不要把会话消息拼进 shell 命令。

## 失败、持久化与结束调度

IM 新会话准备或自动重置期间在原消息上显示临时“敲键盘”表情，成功启动新会话后添加并保留 ✅（`DONE`）标记，作为会话起点；临时表情在运行结束后移除。正常准备与自动重置不额外发送对话消息，重置原因记录在日志。表情接口失败仅记录日志，不阻断脚本或 AI。

启动失败、非法工作目录/结果、非零退出和超时均阻断该轮 AI，向原消息回复退出原因和有限长度的脚本输出。`/stop` 可以取消准备中的 Hook；Hook 的进程组一并终止。准备中断留下的项目资源由结束 Hook 凭相同 session ID 处理。

Bridge 在准备前持久化会话记录。记录与状态位于 profile 的 `sessions.json.catalog.json.resources.json`，与 Agent 会话索引分别承担资源绑定和 thread 索引职责。有效绑定在重启后续用；未完成准备、结束中的记录进入对账处理。记录写入失败会阻断准备，不能假装准备成功。

每个 channel 实例每分钟扫描一次，并在启动时对账。扫描只发现过期/待结束会话，结束任务仍取得与 Agent 相同的 scope 和进程池执行资格，再复核活动引用。工作区只有在相关 Agent 进程和其子进程回收后才能释放。

结束 Hook 失败保留 `ending` 记录并输出错误，不静默恢复旧 thread；定时扫描不无限重试或反复发通知。该会话下次请求先重试结束，仍失败则继续阻断。已经结束的记录保留结束原因，以便下次新请求标记自动重置。配置结束 Hook 的 profile 不允许通过 `/resume` 把历史 thread 绑定到新的项目资源。

## 日志

Hook 日志汇入 profile 的 `logs/bridge-YYYYMMDD.jsonl`，沿用默认 30 天保留策略。记录事件、profile、scope、稳定 session ID、执行目录、触发原因、耗时、退出码与分流的 stdout/stderr，以及会话准备、结束和扫描器启动事件。消息触发时同时带上现有 trace/message 上下文。

项目脚本应记录项目资源标识及关键结果，避免输出凭据或整个环境变量。Bridge 不把脚本日志或私有 state 当作 AI 指令。工作区分配和结束都是可见失败边界，不能用日志代替向用户报告失败。
