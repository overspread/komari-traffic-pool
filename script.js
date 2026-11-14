// komari-traffic-pool —— 共享流量池 Komari 插件
// 按组聚合节点计费口径流量，对比预置额度，阶梯告警（如 Oracle 多机共享 10TB/月）。
// 数据源: public:queryMetrics (net.total.up / net.total.down 单调累计计数器) 增量法累计。
// 引擎: moejs alpha —— 只用基础语法；范式对齐官方 load-notification 插件。

// Komari 插件引擎（moejs）直接执行本文件，它是脚本而非 ESM 模块：
// 不能用 import 语句；宿主注入全局 require / __storageDir__。
// 实测 server 模块只有 9 个成员（无 definePlugin）：call / cron / getConfig /
// hook / injectHTML / registerNotificationChannel / registerRPC / route / static。
// 引擎通过调用 globalThis.load 与 globalThis.unload 来加载和卸载插件。
const server = require("server");
const fs = require("fs");
const path = require("path");

const SHORT = "komari-traffic-pool";
const STATE_FILE = path.join(__storageDir__, "state.json");
const LOG_TAG = `[${SHORT}]`;
const GB = 1024 * 1024 * 1024;
const TB = 1024 * GB;
// 账期按 UTC+8 判定（与旧 cron 脚本一致，不受容器时区影响）
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const DEFAULT_STEPS = [80, 85, 90, 95, 100];
const QUERY_WINDOW_MS = 6 * 60 * 60 * 1000; // 取当前计数器值的窗口（覆盖离线数小时的节点）
const DEFAULT_CFG = { enabled: true, default_interval_minutes: 10, notify_enabled: true };

// ---------- 状态（单内存对象；读写全走这里，避免 cron/RPC 交错时覆盖） ----------
// state = { version, groups: { <id>: { …配置…, period, used, notified, nodes, last_run_at, last_error } } }
let state = { version: 1, groups: {} };
let ticking = false;
// RPC 处理器同步返回（官方 load-notification 即此范式，规避 moejs 对返回 Promise 的序列化风险）；
// 下列缓存由 load() 与每分钟 cron 刷新。
let nodesCache = {};
let lastAction = null; // { type, ok, error, at } —— 异步动作（手动统计/测试通知）的回执
let runtimeCfg = {
  enabled: DEFAULT_CFG.enabled,
  default_interval_minutes: DEFAULT_CFG.default_interval_minutes,
  notify_enabled: DEFAULT_CFG.notify_enabled
};

function log(message, details) {
  if (details === undefined) {
    console.log(LOG_TAG + " " + message);
    return;
  }
  try {
    console.log(LOG_TAG + " " + message, JSON.stringify(details));
  } catch (e) {
    console.log(LOG_TAG + " " + message);
  }
}

function errText(e) {
  return String((e && e.message) || e);
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.groups && typeof parsed.groups === "object") {
        return parsed;
      }
    }
  } catch (e) {
    log("readState failed", { error: errText(e) });
  }
  return { version: 1, groups: {} };
}

function writeState() {
  try {
    fs.mkdirSync(__storageDir__, { recursive: true });
  } catch (e) {
    // 目录已存在时忽略
  }
  try {
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
    } catch (e2) {
      log("writeState failed", { error: errText(e2) });
    }
  }
}

// ---------- 账期 ----------
function daysInMonth(y, m) {
  // m: 1-12；Date.UTC(y, m, 0) = 当月最后一天
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function periodKey(g, nowMs) {
  if (g.reset_mode === "none") return "none";
  const day = clampInt(g.reset_day, 1, 31, 1);
  const t = new Date(nowMs + TZ_OFFSET_MS);
  let y = t.getUTCFullYear();
  let m = t.getUTCMonth() + 1;
  const d = t.getUTCDate();
  const eff = Math.min(day, daysInMonth(y, m));
  if (d < eff) {
    m -= 1;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
  }
  const sd = Math.min(day, daysInMonth(y, m));
  if (day === 1) return y + "-" + pad2(m); // 每月 1 号：YYYY-MM
  return y + "-" + pad2(m) + "-" + pad2(sd); // 其他号：账期起始日
}

function periodLabel(g) {
  return g.period === "none" || !g.period ? "持续累计" : g.period;
}

function resetLabel(g) {
  return g.reset_mode === "none" ? "不归零" : "每月" + clampInt(g.reset_day, 1, 31, 1) + "号重置";
}

// 回填只在“填写时所属账期”内生效，归零后自动失效（避免上期读数带进新账期）
function effBackfill(g) {
  if (!(g.backfill_bytes > 0)) return 0;
  return g.backfill_period === g.period ? g.backfill_bytes : 0;
}

// ---------- 展示辅助 ----------
function fmtBytes(b) {
  const v = Number(b) || 0;
  if (Math.abs(v) >= TB) return (v / TB).toFixed(2) + " TB";
  return (v / GB).toFixed(1) + " GB";
}

function metricLabel(metric) {
  if (metric === "down") return "入站";
  if (metric === "both") return "出站+入站";
  return "出站(计费)";
}

function metricKeys(metric) {
  if (metric === "down") return ["down"];
  if (metric === "both") return ["up", "down"];
  return ["up"];
}

function metricKeyNames(metric) {
  const short = metricKeys(metric);
  const out = [];
  for (const s of short) out.push(s === "down" ? "net.total.down" : "net.total.up");
  return out;
}

// ---------- 节点列表（uuid -> Client） ----------
async function getNodesMap() {
  try {
    const r = await server.call("common:getNodes", {});
    return r && typeof r === "object" ? r : {};
  } catch (e) {
    log("getNodes failed", { error: errText(e) });
    return {};
  }
}

function nodeName(uuid, map) {
  const c = map ? map[uuid] : null;
  if (c && c.name) return c.name;
  return String(uuid || "").slice(0, 8);
}

// ---------- 运行配置（managed configuration，每次 tick 现读以拾取改动） ----------
async function getRuntimeConfig() {
  let saved = {};
  try {
    const c = await server.getConfig();
    if (c && typeof c === "object") saved = c;
  } catch (e) {
    log("getConfig failed", { error: errText(e) });
  }
  const on = (v, dflt) => (v === undefined ? dflt : !(v === false || v === "false" || v === "0"));
  return {
    enabled: on(saved.enabled, DEFAULT_CFG.enabled),
    default_interval_minutes: clampInt(saved.default_interval_minutes, 1, 1440, DEFAULT_CFG.default_interval_minutes),
    notify_enabled: on(saved.notify_enabled, DEFAULT_CFG.notify_enabled)
  };
}

// ---------- 分组配置清洗 ----------
function genId() {
  return "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function parseSteps(v) {
  let list;
  if (Array.isArray(v)) list = v;
  else if (typeof v === "string") list = v.split(/[,，、\s]+/);
  else if (v === undefined || v === null) return DEFAULT_STEPS.slice(); // 未提供 → 默认档位
  else return [];
  const out = [];
  const seen = {};
  for (const raw of list) {
    const n = Number(raw);
    if (!isFinite(n) || n <= 0 || n > 1000) continue;
    const s = Math.round(n * 100) / 100;
    if (seen[s]) continue;
    seen[s] = true;
    out.push(s);
  }
  if (out.length > 30) out.length = 30;
  out.sort((a, b) => a - b);
  return out;
}

function sanitizeGroup(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  const id = typeof raw.id === "string" && raw.id ? raw.id.slice(0, 64) : genId();
  const name = String(raw.name || "").trim().slice(0, 60) || "未命名分组";
  const nodeIds = [];
  const seenN = {};
  const arr = Array.isArray(raw.nodeIds) ? raw.nodeIds : [];
  for (const u of arr) {
    if (typeof u !== "string" || !u || seenN[u]) continue;
    seenN[u] = true;
    nodeIds.push(u);
    if (nodeIds.length >= 200) break;
  }
  let quota_value = Number(raw.quota_value);
  if (!(quota_value > 0)) quota_value = Number(raw.quota);
  if (!isFinite(quota_value) || quota_value < 0) quota_value = 0;
  quota_value = Math.min(quota_value, 10000000);
  const quota_unit = raw.quota_unit === "TB" ? "TB" : "GB";
  const quota_bytes = Math.round(quota_value * (quota_unit === "TB" ? TB : GB));
  const metric = ["up", "down", "both"].indexOf(raw.metric) >= 0 ? raw.metric : "up";
  const reset_mode = raw.reset_mode === "none" ? "none" : "monthly";
  const reset_day = clampInt(raw.reset_day, 1, 31, 1);
  const thresholds = raw.thresholds === undefined ? DEFAULT_STEPS.slice() : parseSteps(raw.thresholds);
  const notify_enabled = !(raw.notify_enabled === false || raw.notify_enabled === "false");
  const ivRaw = Number(raw.interval_minutes);
  const interval_minutes = isFinite(ivRaw) && ivRaw > 0 ? clampInt(ivRaw, 1, 1440, 0) : 0;
  let bfGb = NaN;
  if (raw.backfill_gb !== undefined && raw.backfill_gb !== null && raw.backfill_gb !== "") bfGb = Number(raw.backfill_gb);
  else if (raw.backfill_bytes !== undefined && raw.backfill_bytes !== null && raw.backfill_bytes !== "") bfGb = Number(raw.backfill_bytes) / GB;
  const backfill_bytes = isFinite(bfGb) && bfGb > 0 ? Math.round(Math.min(bfGb, 10000000) * GB) : 0;
  return {
    id, name, nodeIds,
    quota_value, quota_unit, quota_bytes,
    metric, reset_mode, reset_day,
    thresholds, notify_enabled, interval_minutes,
    backfill_bytes
  };
}

function saveGroups(params) {
  const list = Array.isArray(params) ? params : params && Array.isArray(params.groups) ? params.groups : null;
  if (!list) throw new Error("缺少 groups 数组");
  if (list.length > 100) throw new Error("分组数量超限（最多 100）");
  const incoming = {};
  for (const raw of list) {
    const g = sanitizeGroup(raw);
    if (incoming[g.id]) continue;
    incoming[g.id] = g;
  }
  for (const id of Object.keys(state.groups)) {
    if (!incoming[id]) {
      delete state.groups[id];
      log("group removed", { id: id });
    }
  }
  const now = Date.now();
  for (const id of Object.keys(incoming)) {
    const cfg = incoming[id];
    const old = state.groups[id];
    const runtime = old
      ? {
          period: old.period || periodKey(cfg, now),
          used: Number(old.used) || 0,
          notified: Array.isArray(old.notified) ? old.notified : [],
          nodes: old.nodes && typeof old.nodes === "object" ? old.nodes : {},
          last_run_at: old.last_run_at || null,
          last_error: old.last_error || null,
          backfill_period: old.backfill_period || ""
        }
      : { period: periodKey(cfg, now), used: 0, notified: [], nodes: {}, last_run_at: null, last_error: null, backfill_period: "" };
    const merged = {};
    const keys = Object.keys(cfg);
    for (const k of keys) merged[k] = cfg[k];
    const rk = Object.keys(runtime);
    for (const k of rk) merged[k] = runtime[k];
    // 节点被移出分组 → 丢弃该组的基线与累计（重新加入时从新基线起算，避免把移出期间的增量算进来）
    if (old && old.nodes) {
      const keep = {};
      for (const u of cfg.nodeIds) keep[u] = true;
      const bk = Object.keys(old.nodes);
      for (const u of bk) {
        if (!keep[u]) {
          delete merged.nodes[u];
          merged.used = Math.max(0, (Number(merged.used) || 0) - (Number(old.nodes[u].used) || 0));
        }
      }
    }
    const oldBf = old ? Number(old.backfill_bytes) || 0 : -1;
    if (merged.backfill_bytes > 0) {
      // 回填账期只在数值真正被改动（>1MB 容差，吸收 GB↔bytes 浮点换算误差）时刷新
      const changed = Math.abs(merged.backfill_bytes - oldBf) > 1024 * 1024;
      merged.backfill_period = changed || !old || !old.backfill_period ? periodKey(merged, now) : old.backfill_period;
    } else {
      merged.backfill_period = "";
    }
    state.groups[id] = merged;
    log("group saved", { id: id, name: merged.name, nodes: merged.nodeIds.length, quota: merged.quota_value + " " + merged.quota_unit });
  }
}

// ---------- 核心：一期增量累计 ----------
async function tickGroup(g, names, cfg) {
  const now = Date.now();
  const pk = periodKey(g, now);
  if (g.period !== pk) {
    log("period rollover", { group: g.name, from: String(g.period), to: pk });
    g.period = pk;
    g.used = 0;
    g.notified = [];
    const nk = Object.keys(g.nodes || {});
    for (const i of nk) {
      g.nodes[i].used = 0; // 保留 last 基线，跨归零点增量续算（只丢边界一个采样窗口）
    }
  }
  g.last_run_at = new Date().toISOString();
  const nodeIds = g.nodeIds || [];
  if (!nodeIds.length) {
    g.last_error = null;
    return;
  }
  const keys = metricKeys(g.metric);
  const res = await server.call("public:queryMetrics", {
    metric_keys: metricKeyNames(g.metric),
    entity_ids: nodeIds,
    start: new Date(now - QUERY_WINDOW_MS).toISOString(),
    end: new Date(now).toISOString(),
    aggregation: "max", // 单调 counter：max 降采样 == 桶内最新值
    downsample: true,
    fill_empty: false,
    max_points: 120
  });
  const series = (res && res.series) || [];
  const latest = {}; // uuid -> { up?: number, down?: number }
  for (const s of series) {
    const pts = (s && s.points) || [];
    if (!pts.length) continue;
    let best = pts[0];
    for (const p of pts) {
      if (String(p.time) > String(best.time)) best = p;
    }
    const v = Number(best.value);
    if (!isFinite(v)) continue;
    const mk = s.metric_key === "net.total.down" ? "down" : "up";
    if (!latest[s.entity_id]) latest[s.entity_id] = {};
    latest[s.entity_id][mk] = v;
  }
  if (!g.nodes || typeof g.nodes !== "object") g.nodes = {};
  for (const uuid of nodeIds) {
    const cur = latest[uuid];
    if (!cur) continue; // 离线/窗口内无数据：保基线，下次续算
    let st = g.nodes[uuid];
    if (!st || typeof st !== "object") {
      st = { last: {}, used: 0 };
      g.nodes[uuid] = st;
    }
    if (!st.last || typeof st.last !== "object") st.last = {};
    if (!isFinite(Number(st.used)) || Number(st.used) < 0) st.used = 0;
    let add = 0;
    for (const k of keys) {
      const cv = cur[k];
      if (cv === undefined) continue;
      const lv = st.last[k];
      if (lv === undefined || lv === null) {
        st.last[k] = cv; // 首见记基线（从插件上线时刻起算）
        continue;
      }
      const d = cv >= lv ? cv - lv : cv; // 计数器清零（agent 重启）→ 按当前值重新累计
      st.last[k] = cv;
      add += d;
    }
    if (add > 0) {
      st.used = st.used + add;
      g.used = (Number(g.used) || 0) + add;
    }
  }
  g.last_error = null;
  await maybeAlert(g, names, cfg);
}

function alertText(g, step, used, pct, names) {
  const lines = [];
  lines.push("事件：流量池告警");
  const ids = g.nodeIds || [];
  const nameList = [];
  for (const i in ids) nameList.push(nodeName(ids[i], names));
  lines.push("节点：" + nameList.join(", "));
  lines.push("详情：" + g.name + "：" + step + "% 档");
  lines.push(metricLabel(g.metric) + "合计： " + fmtBytes(used) + " / " + fmtBytes(g.quota_bytes) + " (" + pct.toFixed(1) + "%)");
  const nodes = g.nodes || {};
  for (const i in ids) {
    const uuid = ids[i];
    const st = nodes[uuid];
    lines.push("            · " + nodeName(uuid, names) + ": " + (st ? fmtBytes(st.used || 0) : "无数据"));
  }
  if (step >= 100) lines.push("已达到预置额度上限，请尽快处理！");
  lines.push("账期：" + periodLabel(g) + " · " + resetLabel(g));
  return lines.join("\n");
}

async function maybeAlert(g, names, cfg) {
  const steps = Array.isArray(g.thresholds) ? g.thresholds : [];
  if (!steps.length || !(g.quota_bytes > 0)) return;
  const used = (Number(g.used) || 0) + effBackfill(g);
  const pct = (used * 100) / g.quota_bytes;
  const notified = Array.isArray(g.notified) ? g.notified : [];
  const hit = [];
  for (const s of steps) {
    if (pct >= s && notified.indexOf(s) < 0) hit.push(s);
  }
  if (!hit.length) return;
  const step = Math.max.apply(null, hit);
  const wantNotify = cfg.notify_enabled !== false && g.notify_enabled !== false;
  let ok = true;
  if (wantNotify) {
    const emoji = step >= 100 ? "🔴" : step >= 90 ? "⚠️⚠️" : "⚠️";
    try {
      const clients = [];
      const ids = g.nodeIds || [];
      for (const i in ids) clients.push({ uuid: ids[i], name: nodeName(ids[i], names) });
      await server.call("admin:sendNotification", {
        event: {
          event: "流量池告警" + emoji.repeat(3),
          emoji: emoji,
          clients: clients,
          message: alertText(g, step, used, pct, names),
          time: new Date().toISOString()
        }
      });
      log("alert sent", { group: g.name, step: step, pct: Math.round(pct * 10) / 10 });
    } catch (e) {
      ok = false;
      g.last_error = errText(e);
      log("alert send failed", { group: g.name, error: g.last_error });
    }
  } else {
    log("alert suppressed (notify off)", { group: g.name, step: step });
  }
  if (ok) {
    const merged = notified.slice();
    for (const s of hit) {
      if (merged.indexOf(s) < 0) merged.push(s);
    }
    merged.sort((a, b) => a - b);
    g.notified = merged;
  }
}

// ---------- 调度 ----------
// opts: { force: boolean, groupId: string|null } —— force 忽略间隔与全局开关（手动触发）
async function tick(opts) {
  opts = opts || {};
  if (ticking) return buildState();
  ticking = true;
  try {
    const cfg = await getRuntimeConfig();
    runtimeCfg = cfg;
    nodesCache = await getNodesMap();
    const ids = Object.keys(state.groups);
    const now = Date.now();
    const due = [];
    for (const id of ids) {
      if (opts.force) {
        if (opts.groupId && opts.groupId !== id) continue;
        due.push(id);
        continue;
      }
      if (cfg.enabled === false) break; // 全局暂停：本轮不查询不告警（手动触发不受限）
      const g = state.groups[id];
      if (opts.groupId && opts.groupId !== id) continue;
      const iv = (g.interval_minutes > 0 ? g.interval_minutes : cfg.default_interval_minutes) * 60000;
      const lastT = Date.parse(g.last_run_at || "") || 0;
      if (now - lastT >= iv) due.push(id);
    }
    if (due.length) {
      const names = await getNodesMap();
      nodesCache = names;
      for (const i in due) {
        const id = due[i];
        const g = state.groups[id];
        if (!g) continue;
        try {
          await tickGroup(g, names, cfg);
        } catch (e) {
          g.last_error = errText(e);
          log("group tick failed", { group: g.name, error: g.last_error });
        }
      }
      writeState();
    }
    return buildState();
  } finally {
    ticking = false;
  }
}

async function refreshCaches() {
  runtimeCfg = await getRuntimeConfig();
  nodesCache = await getNodesMap();
}

// ---------- 状态汇总（给 admin.html，同步返回缓存） ----------
function buildState() {
  const cfg = runtimeCfg;
  const map = nodesCache;
  const nodes = [];
  const uk = Object.keys(map);
  for (const i in uk) {
    const u = uk[i];
    const c = map[u] || {};
    nodes.push({
      uuid: u,
      name: c.name || u.slice(0, 8),
      region: c.region || "",
      group: c.group || "",
      hidden: !!c.hidden
    });
  }
  nodes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const groups = [];
  const gk = Object.keys(state.groups);
  for (const i in gk) {
    const g = state.groups[gk[i]];
    const used = Number(g.used) || 0;
    const eb = effBackfill(g);
    const display = used + eb;
    const nodeUsed = {};
    const nk = Object.keys(g.nodes || {});
    for (const j in nk) nodeUsed[nk[j]] = Number(g.nodes[nk[j]].used) || 0;
    groups.push({
      id: gk[i],
      name: g.name,
      nodeIds: g.nodeIds || [],
      metric: g.metric,
      quota_value: g.quota_value,
      quota_unit: g.quota_unit,
      quota_bytes: g.quota_bytes,
      reset_mode: g.reset_mode,
      reset_day: g.reset_day,
      thresholds: g.thresholds || [],
      notify_enabled: g.notify_enabled !== false,
      interval_minutes: g.interval_minutes || 0,
      backfill_bytes: g.backfill_bytes || 0,
      backfill_period: g.backfill_period || "",
      backfill_effective: eb,
      backfill_expired: g.backfill_bytes > 0 && eb === 0,
      period: g.period,
      used: used,
      display_used: display,
      pct: g.quota_bytes > 0 ? (display * 100) / g.quota_bytes : 0,
      notified: g.notified || [],
      last_run_at: g.last_run_at || null,
      last_error: g.last_error || null,
      node_used: nodeUsed
    });
  }
  return { version: 1, now: new Date().toISOString(), config: cfg, groups: groups, nodes: nodes, last_action: lastAction };
}

function fireSendTest(g) {
  const used = (Number(g.used) || 0) + effBackfill(g);
  const pct = g.quota_bytes > 0 ? (used * 100) / g.quota_bytes : 0;
  const clients = [];
  const ids = g.nodeIds || [];
  const nameList = [];
  for (const i in ids) {
    const nm = nodeName(ids[i], nodesCache);
    clients.push({ uuid: ids[i], name: nm });
    nameList.push(nm);
  }
  const lines = [];
  lines.push("事件：流量池测试");
  lines.push("节点：" + nameList.join(", "));
  lines.push("详情：" + g.name + " 测试通知正常。");
  lines.push(metricLabel(g.metric) + "合计： " + fmtBytes(used) + " / " + fmtBytes(g.quota_bytes) + " (" + pct.toFixed(1) + "%)");
  const nodes = g.nodes || {};
  for (const i in ids) {
    const uuid = ids[i];
    const st = nodes[uuid];
    lines.push("            · " + nodeName(uuid, nodesCache) + ": " + (st ? fmtBytes(st.used || 0) : "无数据"));
  }
  lines.push("账期：" + periodLabel(g) + " · " + resetLabel(g));
  return server.call("admin:sendNotification", {
    event: {
      event: "流量池测试🧪🧪🧪",
      emoji: "🧪",
      clients: clients,
      message: lines.join("\n"),
      time: new Date().toISOString()
    }
  });
}

// ---------- 入口 ----------
// 说明：本引擎不提供 definePlugin，而是加载脚本后调用 globalThis.load / globalThis.unload。
// RPC 处理器一律同步返回（规避 moejs 对返回值做序列化时遇到 Promise 的风险）；
// 异步动作（tickNow / sendTest）先回执 started，完成后写入 lastAction 供页面轮询读取。
globalThis.load = async function () {
  state = readState();
  await refreshCaches();

  server.registerRPC("plugin:" + SHORT + ":getState", () => buildState());
  server.registerRPC("plugin:" + SHORT + ":saveGroups", (params) => {
    saveGroups(params);
    writeState();
    return buildState();
  });
  server.registerRPC("plugin:" + SHORT + ":tickNow", (params) => {
    const gid = params && params.group_id ? String(params.group_id) : null;
    const aid = params && params.aid ? String(params.aid).slice(0, 64) : "";
    lastAction = { type: "tick", aid: aid, ok: null, error: null, at: new Date().toISOString() };
    tick({ force: true, groupId: gid })
      .then(() => {
        lastAction = { type: "tick", aid: aid, ok: true, error: null, at: new Date().toISOString() };
      })
      .catch((e) => {
        lastAction = { type: "tick", aid: aid, ok: false, error: errText(e), at: new Date().toISOString() };
        log("manual tick failed", { error: errText(e) });
      });
    return { started: true, aid: aid };
  });
  server.registerRPC("plugin:" + SHORT + ":sendTest", (params) => {
    const gid = params && params.group_id ? String(params.group_id) : "";
    const aid = params && params.aid ? String(params.aid).slice(0, 64) : "";
    const g = state.groups[gid];
    if (!g) return { started: false, aid: aid, error: "分组不存在: " + gid };
    lastAction = { type: "sendTest", aid: aid, ok: null, error: null, at: new Date().toISOString() };
    fireSendTest(g)
      .then(() => {
        lastAction = { type: "sendTest", aid: aid, ok: true, error: null, at: new Date().toISOString() };
        log("test notification sent", { group: g.name });
      })
      .catch((e) => {
        lastAction = { type: "sendTest", aid: aid, ok: false, error: errText(e), at: new Date().toISOString() };
        log("test notification failed", { group: g.name, error: errText(e) });
      });
    return { started: true, aid: aid };
  });

  server.cron("@every 1m", async () => {
    try {
      await refreshCaches();
      await tick({});
    } catch (e) {
      log("tick failed", { error: errText(e) });
    }
  });

  log("plugin loaded", { groups: Object.keys(state.groups).length });
};

globalThis.unload = function () {
  try {
    writeState();
  } catch (e) {
    log("unload writeState failed", { error: errText(e) });
  }
};
