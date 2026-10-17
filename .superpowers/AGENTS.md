<!-- 加载时机：本文件**不会**被 harness 自动加载；agent 用 `read`/`write`/`edit` 触达 `.superpowers/` 目录后由 harness 自动注入。 -->
<!-- 定位：**SDD 台账与证据的落点与形制**（写在哪、写成什么样）。目录本身不进 git，见 §一。 -->

# .superpowers/AGENTS.md —— SDD 台账与证据的落点与形制

## 一、落点（唯一，不许另立目录）

| 产物 | 落点 | 说明 |
|---|---|---|
| **实现架构账本** | `.superpowers/sdd/<topic>/impl-ledger.md` | 一个 topic 一份；`<topic>` 与派单书里的责任区同名（如 `2026-10-17-liangshen-bundle-skeleton`） |
| **证据** | `.superpowers/sdd/<topic>/evidence/`（**同目录**） | 命令 + 真实输出 + md5 / 计数 / 会话 header 摘要；独立对照矩阵与负向验证各自留证 |
| SDD 进度台账 | `.superpowers/sdd/<topic>/progress.md` | 逐任务推进记录 |
| 逐任务报告 | `.superpowers/sdd/<topic>/task-N-report.md` | 该任务的交账（含「我没做 / 没验证的」一节） |

★★ `.superpowers/sdd/` 被 `.gitignore` 忽略 ⇒ 整棵不进 git：内容只在本机留痕。
⇒ **要长期留存、跨会话 / 跨设备复用的结论，必须另写进 `docs/superpowers/**`（spec / plan / status）或根 `AGENTS.md` 索引到的长文**；
台账与证据**不是交付物**，`docs/**` 才是。引用台账时写明它是**本机留痕、不在版本库里**。

## 二、`impl-ledger.md` 五要素（实现方自己写）

1. **关键调查结论**：`path:line` 证据 → 结论 → 影响；
2. **自己的实现架构**：组件拆分、插件/事件/服务边界、实际数据流与调用次序；
3. **关键判断**：为什么这样拆、为什么不用另一条路线、调查中推翻过什么；
4. **偏离记录**：与约束设计书（spec）不一致之处及原因（主动记录，不隐瞒）；
5. **只记决策相关事实，不写流水账、不抄工具输出**（关键行原文可摘，长输出给命令）。

★ 分工别混：**约束设计书**（控制方写，落 `docs/superpowers/specs/*`）冻结「模式必须长成什么样」；
**`impl-ledger.md`**（实现方写）决定「代码/组合怎么把它长出来」；**报告**是交给控制方的交账
（改动文件 / 验证命令与结果 / 会改变模型可见面的清单 / 失效断言清单 / 未完成项）。三者各有落点，不要互相代替。

## 三、本项目特有证据要求（DSH 插件/preset）

- **协议级证据**：真实会话导出 JSONL，检查 `request/header`（首轮 `system` = persona 块；首轮 tools = Minimal 双工具；
  晋升后全目录；压缩后重新收窄；分页/激活状态从事件流重建；目录宣告面 = wire 实际面）。命令与关键行写进 `evidence/`。
- **隔离对照**：物化 preset 到临时目录 + 本轮自己的 agent-preset registry 声明 + 会话持久化改写，记录基线
  （DSH 版本 / preset 源码 hash / 模型 route / 任务集版本 / 费用）。**单次 smoke 不构成提升证据**。
- **兼容回归**：事件 `source.kind` 词表、preset id、会话恢复路径各留一条用例（见 dsh-web issue #1455 / #1593 的教训）。
- 不许把「没跑 / 没验证」写成「通过」；没结论就写「未验证」。
