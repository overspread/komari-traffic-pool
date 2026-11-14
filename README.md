# 共享流量池 / Shared Traffic Pool (kkr-traffic-pool)

> Komari 插件：按组聚合节点流量，对比预置额度，阶梯告警。为「多台机器共享同一份月度流量额度」（例如 Oracle Cloud 免费层多实例共享 10TB/月）这类场景设计。

A [Komari](https://github.com/komari-monitor/komari) plugin that aggregates node traffic per group against a preset quota with stepped alerts. Designed for the case where several machines share one monthly traffic quota (e.g. multiple Oracle Cloud free-tier instances sharing 10TB/month).

---

## 解决什么问题 / The problem it solves

Komari 原生的流量额度（traffic limit）是**按单个节点**设置的。但 Oracle Cloud 免费层这类平台，额度是**整个账户共享**的：10 台机器各自跑一点流量，合起来超了 10TB 才会触发超额，单看任何一台都看不出风险。

原生 per-node traffic limit is per-node only. But platforms like Oracle Cloud free tier share one quota across the whole account — 10 instances each moving a little traffic will collectively exceed 10TB, and no single node shows the risk.

这个插件把额度提升到**组**的层面：多个节点加进一个组，流量加总后跟组额度比，按你设的阈值阶梯告警。

This plugin moves the quota to the **group** level: add multiple nodes to a group, sum their traffic, compare it to the group quota, and alert at the thresholds you set.

## 功能 / Features

- **多分组**：每个组独立配额度、计费口径、归零规则、告警阈值；节点可跨组复用
- **计费口径**：`up`（仅出站）/ `down`（仅入站）/ `both`（求和），每组可单独选
- **归零规则**：`monthly`（每月固定 1–31 号，对齐你的账单周期）或 `none`（永不归零），每组可选
- **自由阈值**：任意百分比数组，默认 `[80, 85, 90, 95, 100]`；**每档每期只告警一次**，归零后自动重置
- **手动回填**：填入本期起始已用量，跟面板统计对齐（解决面板上线时间晚于账期开始的问题）
- **通知通道**：走 Komari 自带通知渠道（Telegram / Email / Bark / Gotify / Server酱 等任你配）；全局开关 + 每组独立开关
- **刷新间隔**：全局默认 + 每组覆盖，最小 1 分钟
- **节点明细**：每组进度条展示已用 / 额度 / 百分比，并可展开查看组内每个节点贡献了多少

- **Multiple groups**, each with its own quota, billing mode, reset rule and thresholds; nodes can belong to several groups
- **Billing mode**: `up` / `down` / `both`, per group
- **Reset rule**: `monthly` (fixed day 1–31, aligned to your billing cycle) or `none`, per group
- **Free-form thresholds**, default `[80, 85, 90, 95, 100]`; each step fires **once per period**, reset after the quota resets
- **Manual backfill** to align the panel's counter with your provider's console
- **Notification channels**: uses Komari's built-in channels (Telegram / Email / Bark / Gotify / ServerChan…); global switch + per-group switch
- **Refresh interval**: global default + per-group override, minimum 1 minute
- **Per-node breakdown**: progress bar per group plus each node's contribution

## 安装 / Install

### 方式一：插件市场 / From the plugin market（推荐）

在 Komari 后台 → **插件** → **插件市场**，搜索 `kkr-traffic-pool` 或「共享流量池」，安装并启用即可。

In Komari admin → **Plugins** → **Market**, search for `kkr-traffic-pool` or "Shared Traffic Pool".

### 方式二：手动上传 / Manual upload

从 [Releases](../../releases) 下载 `kkr-traffic-pool.zip`，在 Komari 后台 → **插件** → 上传插件，选择该 zip，然后启用。

Download `kkr-traffic-pool.zip` from [Releases](../../releases), upload it in Komari admin → **Plugins**, then enable it.

### 要求 / Requirements

- Komari `>= 1.6.0`
- 权限：`node`（读节点流量）、`allowSystemRPC`（调用 `public:queryMetrics`）

## 使用 / Usage

1. 启用插件后，左侧菜单出现 **共享流量池** 入口。
2. 点 **新建分组**，选节点、填额度（数字 + GB/TB 单位）、选计费口径和归零规则。
3. 需要回填时，在「本期开始前已用」里填入你从服务商控制台查到的本期已用量。
4. 保存后插件立即统计一次；之后按刷新间隔自动统计，到阈值时经通知渠道推送。

1. After enabling, a **Shared Traffic Pool** entry appears in the sidebar.
2. Click **New group**, pick nodes, set the quota (number + GB/TB), choose billing mode and reset rule.
3. To backfill, enter the amount already used this period from your provider's console.
4. On save the plugin tallies immediately, then re-tallies every interval and pushes an alert at each threshold.

## 工作原理 / How it works

- 数据源用 Komari 的 `public:queryMetrics` 取 `net.total.up` / `net.total.down`（单调累计计数器）。
- 用**增量法**累计：`delta = 当前值 - 上次值`；若当前值小于上次值（计数器被清零，如重启）则 `delta = 当前值`；节点离线时跳过并保留其基线。
- 本期已用 = `backfill_bytes` + 组内各节点本期增量之和。
- 账期按 **UTC+8** 判定，不受容器时区影响。
- 状态原子写入 `plugin-data/kkr-traffic-pool/state.json`。

- Reads `net.total.up` / `net.total.down` (monotonic counters) via Komari's `public:queryMetrics`.
- Uses **incremental** accumulation: `delta = current - last`; if the counter is reset (e.g. reboot) then `delta = current`; offline nodes are skipped while keeping their baseline.
- Used this period = `backfill_bytes` + the sum of each node's increment in the group.
- Billing periods are evaluated in **UTC+8**, independent of the container's timezone.
- State is written atomically to `plugin-data/kkr-traffic-pool/state.json`.

## 限制 / Limitations

- 只统计 `net.total.up` / `net.total.down`（累计计数器），与 `traffic.up` / `traffic.down` 可能存在微小口径差异。
- 插件首次启用时从 0 起算，历史无法回溯，需用「回填」补齐。

- Only `net.total.up` / `net.total.down` are used; there can be a small accounting difference vs `traffic.up` / `traffic.down`.
- Counting starts from zero on first install; history can't be back-filled automatically, use the backfill field.

## 致谢 / Credits

- UI 复用了 [Radix Themes](https://github.com/radix-ui/themes) 的 CSS/JS（`assets/` 下），MIT 许可。
- 插件范式参考 Komari 官方 `load-notification` 插件。

- The UI reuses CSS/JS from [Radix Themes](https://github.com/radix-ui/themes) (in `assets/`), MIT licensed.
- Plugin structure follows Komari's official `load-notification` plugin.

## 许可 / License

MIT
