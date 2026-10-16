# QA 会话生命周期改造记录

当前实现契约见 [会话生命周期与 Hook](../session-hooks.md)，本文保留已确认的产品决策和部署验证信息。

## 已确认决策

- 用户授权 fork、自行实现并部署至 mbp14，重启 libtv-qa 和 libtv-mobile-qa。
- 默认空闲 15 分钟，0 可关闭；从上一轮完成计算，排队等待不导致清除上下文。
- 新会话与逻辑会话结束分别触发 beforeSessionStart 和 afterSessionEnd。Bridge 不感知 Git/worktree，项目脚本分别拥有准备与回收策略。
- 两个 QA 项目各自维护脚本，不共享运行时同步实现。显式 hook cwd 与最终 Agent 工作目录可以不同。
- 主仓和各子模块均创建 detached worktree，每段会话固定主仓 SHA 和 gitlink；群/话题间工作目录隔离，多轮续用原快照。
- 基础源码缓存对齐最新 origin 默认分支，清理已跟踪修改与未跟踪文件；忽略文件保留。创建出来的会话快照必须干净。
- 会话默认空闲 15 分钟失效，启动时及每分钟检查结束；有运行或排队引用时不释放资源。
- 普通重启恢复有效会话。准备/结束中断凭稳定 session ID 对账。失败阻断对话并输出至飞书；结束失败保留记录，下一请求重试，禁止悄悄续接旧 thread。
- QA AGENTS.md 移除 AI 拉库和清理职责，改为只读本会话源码快照；Desktop 打包正文引用仓库唯一 SOP。
- 初次部署两个 profile 各自保留 maxConcurrentRuns=1，新的资源隔离不静默提高并发。

## 部署位置

Fork: https://github.com/hpop1994/lark-coding-agent-bridge 。

两个脚本分别位于：

- `/Volumes/ZHITAI/project/lib_proj/libtv-qa/hooks/session.py`
- `/Volumes/ZHITAI/project/lib_proj/libtv-mobile-qa/hooks/session.py`

各自在 QA 根目录的 workspaces/<session-id> 下创建会话目录，包含本项目源码仓库。父目录 AGENTS.md 为所有会话提供一致的答疑边界。所有部署前规则和配置均保留备份。

## mbp14 验证记录

Apple Git 2.50.1，ZHITAI 磁盘。临时仓库实验和真实 Desktop/Mobile 仓库均验证了主仓及子模块工作目录独立、保持固定提交、状态干净和逆序回收。

| 场景 | Desktop | Mobile |
| --- | --- | --- |
| 缓存对象下主仓及子模块 worktree 创建 | 5.2 秒 | 3.4 秒 |
| 状态及子模块验证 | 2.1 秒 | 0.9 秒 |
| 逆序回收 | 2.0 秒 | 1.3 秒 |
| 完整项目 hook（含 fetch 与缓存同步） | 20–23 秒 | 8–11 秒 |

真实脚本分别创建两份会话快照，第二次准备后第一份仍保持原提交且干净，随后全部回收。验证日志保存在各 QA hooks/logs/ 中。缓存测量不含首次克隆、缺失对象或 LFS 下载，完整 hook 时间受网络和上游变化影响。

实现测试覆盖非法配置、工作目录和结构化结果、Claude/Codex 阈值、排队、持久化与恢复、独立工作目录、多轮 thread 绑定、结束失败、Hook 超时与取消，以及向原飞书消息输出 Hook 错误且不启动 AI。
