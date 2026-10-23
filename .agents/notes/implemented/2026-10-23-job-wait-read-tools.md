# 2026-10-23 — 后台任务 `job_wait` / `job_read`（D-023）

## 问题

`bash` 前台调用会等命令结束（本机 preset 的 `persistent-bash.timeoutMs = 300000`），超时后转成后台 job 并返回
job id。官方 `job_output` 支持 `wait: true`，但：

- `wait` 默认 **false**（`dsh-tool-jobs/lib/index.js:306`）；
- `wait: true` 的默认等待只有 **30 秒**（`waitTimeoutMs` 默认 `30000`，上限 `600000`）。

于是长构建被转后台后，模型往往用 `sleep` + `job_output` 轮询，既浪费 step，也容易错过完成。

## 决定

新增 Agent 级工具 `@mosire/dsh-job-tools`，把动词拆成 **创建 / 等待 / 读取**：

1. **创建不动**：继续由 `bash(run_in_background: true)`（以及 workflow/subagent 等生产者）调用官方 job 注册表。
   不新增 `job_start`，避免复制 sandbox / policy / persistent-shell / job 准入逻辑。
2. **`job_wait(job_id, timeout_seconds?)`**：调用 `ctx.jobs.wait(id, ms, caller, signal)`，只返回状态：
   `jobId/status/detail/timedOut/elapsedMs/startedAt/finishedAt`。默认 600s、上限 3600s；
   超时返回 `timedOut: true` 且**不杀 job**；工具调用取消时中止等待。
3. **`job_read(job_id, mode?, lines?, max_bytes?, from_offset?)`**：
   - 用 `ctx.jobs.readAt(id, from_offset, caller)` **非消费读取**，不推进 `job_output` 的模型游标；
   - 用 `ctx.jobs.get` 取状态、`spillPaths`；
   - 字符优化 `lib/optimize.js`：ANSI CSI/OSC 清理、控制字符清理、`\r` 进度折叠、行尾空白、空行压缩、
     相邻重复行 `(×N)`、`auto/full/head/tail/errors/summary/raw` 模式、head+tail 字节上限与 omitted 标记；
   - 返回 `text/inputLines/outputLines/inputBytes/outputBytes/dedupedLines/omittedLines/omittedBytes/matchedErrors/lossy/nextOffset`；
   - 对 final-output job，ring 为空且 job 已结束时回退 `ctx.jobs.read` 取 `result`（`source: "result"`）。

## 安装与锚定

- `@mosire/dsh-job-tools` 跟随官方 Agent 工具模型：在每个 live Agent scope 的 `agent.ctx.tools` 注册，
  监听 `agent/created` / `agent/disposed`；不按 depth 过滤（子 Agent 也能等自己的 job）。
- `@mosire/dshom` 增加 `features.jobTools` 与 `jobTools` 配置；`agents` / `jobs` 服务缺失时 fail-open。
- 不改 `tool-bootstrap`：首轮仍只暴露 `bash` + `str_replace_editor`，新工具在晋升后的完整目录出现。

## 证据

- 单测：`@mosire/dsh-job-tools` 18/18（optimizer 9 + tools 9），覆盖默认/上限超时、超时不杀、stderr 分区、
  log 丢弃、ANSI/重复行、lossy 提示、final-output result、非法配置。
- 临时 `dsh web --port 3099 --no-open` 加载 dshom：`$DSH_HOME/job-tools-status.json`
  `activated: true, tools: ["job_wait","job_read"]`；两预设 `broken:null`。
- 真实 Agent 注册：`dsh --profile headless --patch /tmp/dshom-verify.patch.yml "<task>"` 创建 Agent 后，
  status 文件 `installed: ["session-a63f3436-…"]`；该次 headless 因未配置 `DEEPSEEK_API_KEY` 未发起模型请求，
  所以**没有**真实模型调用 job_wait/job_read 的证据。
- **未验**：真实 `ctx.jobs` 的 `job_wait` 阻塞时长与 `job_read` 输出（需重启 3080 Host 后在真实会话跑）。

## 边界

- `nohup ... &` / daemon：job 随 shell 退出而结束，不等孙进程。
- 常驻服务器：用 `job_output`/`job_list`，不要 `job_wait`。
- 子 Agent 的 job 归子 Agent 所有；父 Agent 不能跨会话 `job_wait`（未来可扩展 `subagent_wait`）。
- `job_read` 的 `raw` 模式不做字节上限；`full` 仍会做字节上限与 omitted 标记。
