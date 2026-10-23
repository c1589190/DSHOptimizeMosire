# @mosire/dsh-job-tools

`@mosire/dshom` 的后台任务工具：**等待**与**读取**分开，读取带确定性字符优化。

## 为什么

DSH 的 `job_output` 可以 `wait: true`，但默认不等待，`wait: true` 的默认上限也只有 30 秒。长构建被 `bash` 提升为后台 job 后，模型容易退化成反复 `sleep` + 读输出。

本包新增两个 Agent 级工具，创建仍由生产者负责（`bash` 的 `run_in_background`，或 workflow/subagent 的 job），因此不复制 sandbox / policy / persistent shell：

| 工具 | 作用 |
|---|---|
| `job_wait(job_id, timeout_seconds?)` | 阻塞到 job 结束，只返回状态（status/detail/timedOut/elapsedMs），**不返回输出、不杀 job** |
| `job_read(job_id, mode?, lines?, max_bytes?, from_offset?)` | 在绝对字节偏移读取输出，做字符级压缩；**不消费 `job_output` 的游标** |

推荐流程：

```text
bash(run_in_background=true, command) → job_id
job_wait(job_id)                      → completed / failed / running
job_read(job_id, mode="summary")      → 优化后的输出
```

## `job_read` 的字符优化

- 去 ANSI CSI/OSC 与 NUL/控制字符；
- `\r` 进度条折叠为最后可见状态；
- 连续重复行合并为 `line (×N)`；
- 去行尾空格、压缩 3 行以上空行；
- `mode`：`auto`（默认）、`full`、`head`、`tail`、`errors`、`summary`、`raw`；
- 超过 `max_bytes` 时保留 head + tail，插入
  `[optimized: omitted N lines / M bytes ...]`，并返回 spill 文件路径；
- 全程确定性、不调用 LLM 摘要；需要逐字节排查时用 `raw`。

`from_offset` 用上一次返回的 `nextOffset` 即可只读增量；`readAt` 不推进 `job_output` 的模型游标，二者可以共存。

## 配置（`dshom` 的 `jobTools`）

```yaml
jobTools:
  enabled: true
  defaultTimeoutSeconds: 600   # job_wait 默认等待
  maxTimeoutSeconds: 3600      # job_wait 上限
  maxBytes: 16384              # job_read 默认/最大字节
  defaultLines: 200            # head/tail/summary 默认行预算
```

## 边界

- `nohup ... &` / daemon：job 随 shell 退出而结束，不会等待孙进程。
- 常驻服务器：用官方 `job_output`/`job_list`，不要 `job_wait`。
- 子 Agent 的 job 归子 Agent 所有；父 Agent 不能跨会话 `job_wait`。
- 首轮锚定不变：这两个工具在 `tool-bootstrap` 晋升后的完整目录才出现。
