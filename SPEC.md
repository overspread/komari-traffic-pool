# kkr-traffic-pool 规格（用户已确认，2026-11-12）

## 形态
- Komari 官方插件（目录 `/opt/komari/data/plugin/kkr-traffic-pool/`），后台→插件页可见可配
- 页面入口：`pages[0]` → iframe `admin.html`，visibility=admin
- 上线后退役 `/usr/local/bin/komari-traffic-pool.py` cron（防双跑双报）

## 分组配置（每组，界面可建多组，节点可跨组复用）
| 项 | 取值 |
|---|---|
| 组名 + 节点 | 从面板节点列表多选 |
| 预置额度 | 数字 + 单位 GB/TB → quota_bytes |
| 计费口径 | 单选 `up` \| `down` \| `both`；默认 `up`（用户选"适配"→ 每组可选） |
| 归零 | 单选 `monthly`(每月固定 1–31 号) \| `none`；**每组可选** |
| 告警阈值 | 自由增删的百分比数组；默认 `[80,85,90,95,100]` |
| 通知开关 | 每组一个 + 全局 `notify_enabled`（managed configuration） |
| 刷新间隔 | 每组覆盖，默认 10 分钟（managed `default_interval_minutes`） |
| 回填 | `backfill_bytes` 手填本期起始已用（OCI 控制台查回填） |

## 展示（admin.html）
- 每组进度条：已用 / 额度 / 百分比 + **最后更新时间**（`last_run_at`）+ 归零日
- 组内每节点贡献明细（名 + 本期已用）
- 保存分组配置的表单

## 告警
- 节奏：**每档每期一次**（`notified_steps`），归零后清空
- 通道：`admin:sendNotification`（Event{event, emoji, clients[], message, time}，time=ISO8601+08:00）
- 文案：组名 + 百分比档 + 合计/额度 + 各节点明细 + 账期

## 累计算法（已在旧 cron 脚本验证）
- 数据源：`public:queryMetrics` 取 `net.total.up/down`（counter 单调累计，交叉验证误差<1%）
- 增量法：`delta = cur-last`；`cur<last`（计数器清零）→ `delta=cur`；节点离线→跳过保基线
- 新节点首见→记基线 used=0；额度变更→立即按新额度重算百分比不丢历史
- period key：`monthly(day=D)` → 含 D 号的账期；`none` → 永不归零
- 本期已用 = backfill_bytes + Σ(组内各节点本期增量)

## 状态持久化
`plugin-data/kkr-traffic-pool/state.json`（原子写），结构：
```json
{"groups": {"<id>": {"period": "2026-11", "used": 0, "notified": [],
  "nodes": {"<uuid>": {"last": 123.0, "used": 0}}, "last_run_at": "..."}}}
```

## 交接
- 旧方案（cron+直读 sqlite）设计与验证见 `../komari-traffic-pool.py`（保留档）
- 插件上线后 state 从 0 起算（用户已选"从上线时起累计"）
