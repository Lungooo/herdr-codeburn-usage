// Plain logic for the codeburn usage panel: no imports, so Node can drive it directly.
// Input is one `codeburn status --format menubar-json --scope combined --combined-details` payload.

// [codeburn --period, chip label]. codeburn's "all" is only the last 6 months; "lifetime" is all.
export const RANGES = [["today", "Today"], ["week", "7 days"], ["30days", "30 days"], ["lifetime", "All"]];
export const ALL = "all";

const ZERO = { cost: 0, calls: 0, sessions: 0, inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
const n = x => (typeof x === "number" && isFinite(x) ? x : 0);

// A period name ("today"), a custom range ({from, to}) or one day ({day}), all YYYY-MM-DD.
export function codeburnArgs(query) {
  const range = typeof query === "string" ? ["--period", query]
    : query.day ? ["--day", query.day] : ["--from", query.from, "--to", query.to];
  return ["status", "--format", "menubar-json", "--scope", "combined", "--combined-details",
    ...range, "--no-optimize", "--no-timeline"];
}

// codeburn prints one JSON line; a stray warning line before it is skipped.
export function parsePayload(stdout) {
  const text = String(stdout ?? "").trim();
  try { return JSON.parse(text); } catch {}
  const line = text.split("\n").reverse().find(l => l.startsWith("{"));
  return line ? JSON.parse(line) : null;
}

// Only what summarize() reads, so the on-disk cache stays a few KiB instead of ~150.
export function slim(payload) {
  const c = payload?.current ?? {};
  const pick = (o, keys) => Object.fromEntries(keys.filter(k => o?.[k] !== undefined).map(k => [k, o[k]]));
  const model = m => pick(m, ["name", "calls", "cost", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]);
  return {
    current: {
      ...pick(c, ["label", "cost", "calls", "sessions", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "providers"]),
      topModels: (c.topModels ?? []).map(model),
      topProjects: (c.topProjects ?? []).map(p => pick(p, ["id", "name", "cost", "sessions"])),
    },
    currency: payload?.currency,
    ...(payload?.combined ? { combined: { perDevice: payload.combined.perDevice } } : {}),
    ...(payload?.combinedDevices ? {
      combinedDevices: payload.combinedDevices.map(d => ({
        ...pick(d, ["id", "name", "local", "error"]),
        ...(!d.local && d.payload ? { payload: { current: {
          topModels: (d.payload.current?.topModels ?? []).map(model),
          ...pick(d.payload.current, ["providers"]),
        } } } : {}),
      })),
    } : {}),
  };
}

// A device codeburn couldn't reach this time keeps its numbers from `prev` (the cache entry this
// answer replaces), marked `cachedAt`: when they were last read. Today's numbers only count today.
export function carryOver(prev, next, now, period) {
  const per = next?.combined?.perDevice;
  if (!prev?.payload || !Array.isArray(per) || !per.some(d => d.error)) return next;
  const old = new Map((prev.payload.combined?.perDevice ?? []).map(d => [d.id, d]));
  const details = new Map((prev.payload.combinedDevices ?? []).map(d => [d.id, d.payload]));
  const since = new Map();
  for (const d of per) {
    const o = old.get(d.id);
    if (!d.error || !o || (o.error && !o.cachedAt)) continue;
    const at = o.cachedAt ?? prev.at;
    if (period === "today" && localDate(new Date(at)) !== localDate(new Date(now))) continue;
    since.set(d.id, at);
  }
  if (since.size === 0) return next;
  return {
    ...next,
    combined: { ...next.combined, perDevice: per.map(d => since.has(d.id)
      ? { ...old.get(d.id), name: d.name, error: d.error, cachedAt: since.get(d.id) } : d) },
    ...(next.combinedDevices ? { combinedDevices: next.combinedDevices.map(d => since.has(d.id) && details.get(d.id)
      ? { ...d, payload: details.get(d.id) } : d) } : {}),
  };
}

function localTotals(cur) {
  const t = {
    cost: n(cur?.cost), calls: n(cur?.calls), sessions: n(cur?.sessions),
    inputTokens: n(cur?.inputTokens), outputTokens: n(cur?.outputTokens),
    cacheCreateTokens: n(cur?.cacheWriteTokens), cacheReadTokens: n(cur?.cacheReadTokens),
  };
  t.totalTokens = t.inputTokens + t.outputTokens + t.cacheCreateTokens + t.cacheReadTokens;
  return t;
}

// The devices codeburn reported (this one first), each with its totals and its own payload.
// Without paired devices, or an older codeburn, it is just this device.
export function devicesOf(payload) {
  const per = payload?.combined?.perDevice;
  const details = new Map((payload?.combinedDevices ?? []).map(d => [d.id, d.payload]));
  if (!Array.isArray(per) || per.length === 0)
    return [{ id: "local", name: "this device", local: true, totals: localTotals(payload?.current), payload }];
  return per.map(d => ({
    id: d.id, name: d.name, local: !!d.local, error: d.error, cachedAt: d.cachedAt,
    totals: { ...ZERO, ...Object.fromEntries(Object.keys(ZERO).map(k => [k, n(d[k])])) },
    payload: d.local ? payload : details.get(d.id),
  }));
}

// What the panel shows for one device id, or ALL for every reachable one (and every offline one
// with cached numbers).
export function summarize(payload, device = ALL) {
  const devices = devicesOf(payload);
  const chosen = devices.find(d => d.id === device);
  const picked = chosen ? [chosen] : devices.filter(d => !d.error || d.cachedAt);
  const totals = { ...ZERO };
  for (const d of picked) for (const k of Object.keys(ZERO)) totals[k] += d.totals[k];

  // Per model, merged by codeburn's display name across the picked devices.
  const models = new Map();
  for (const d of picked) {
    for (const m of d.payload?.current?.topModels ?? []) {
      const acc = models.get(m.name) ?? { name: m.name, calls: 0, cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, devices: 0 };
      acc.calls += n(m.calls); acc.cost += n(m.cost);
      acc.inputTokens += n(m.inputTokens); acc.outputTokens += n(m.outputTokens);
      acc.cacheReadTokens += n(m.cacheReadTokens); acc.cacheWriteTokens += n(m.cacheWriteTokens);
      acc.devices += 1;
      models.set(m.name, acc);
    }
  }
  const modelRows = [...models.values()]
    .map(m => ({ ...m, tokens: m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens }))
    .sort((a, b) => b.tokens - a.tokens || b.cost - a.cost);

  // codeburn never shares project rows between devices, so projects are this device's only.
  const local = devices.find(d => d.local);
  const showProjects = !chosen || chosen.local;
  const projects = showProjects ? (local?.payload?.current?.topProjects ?? [])
    .map(p => ({ path: p.id ?? p.name, name: p.name, cost: n(p.cost), sessions: n(p.sessions) }))
    .sort((a, b) => b.cost - a.cost) : null;

  return {
    devices, chosen: chosen ?? null, totals, models: modelRows, projects,
    reachable: devices.filter(d => !d.error).length,
    cached: devices.filter(d => d.error && d.cachedAt).length,
    hitRate: totals.inputTokens + totals.cacheReadTokens > 0
      ? totals.cacheReadTokens / (totals.inputTokens + totals.cacheReadTokens) : 0,
    label: payload?.current?.label ?? "",
    currency: payload?.currency ?? { code: "USD", symbol: "$", rate: 1 },
  };
}

// ---- Plans: codeburn's budget math (src/plan-usage.ts), over every device instead of this one.
// codeburn computes plan usage from this machine's logs only, so the mod reads the plans from
// `codeburn plan --format json` and sums each device's `current.providers` itself.

// codeburn's order, ids and names (src/plans.ts).
const PLAN_PROVIDERS = ["all", "claude", "codex", "cursor", "grok", "copilot", "antigravity"];
const PLAN_NAMES = {
  "claude-pro": "Claude Pro", "claude-max": "Claude Max 20x", "claude-max-5x": "Claude Max 5x",
  "cursor-pro": "Cursor Pro", "supergrok": "SuperGrok", "supergrok-heavy": "SuperGrok Heavy",
  "copilot-pro": "Copilot Pro", "copilot-pro-plus": "Copilot Pro+", "copilot-max": "Copilot Max",
  "google-ai-pro": "Google AI Pro", "google-ai-ultra-5x": "Google AI Ultra 5x", "google-ai-ultra-20x": "Google AI Ultra 20x",
};
export const PROVIDER_LABELS = { all: "All", claude: "Claude", codex: "Codex", cursor: "Cursor", grok: "Grok", copilot: "Copilot", antigravity: "Antigravity" };
const NEAR_PCT = 80, TRAILING_DAYS = 7, MS_DAY = 86400000;

export const planArgs = () => ["plan", "--format", "json"];
// Copilot plans count credits the combined payload doesn't carry: codeburn's own (local) numbers.
export const localPlanArgs = () => ["status", "--format", "json"];

// The active plans, in codeburn's order. Older codeburn printed one plan without the `plans` map.
export function parsePlans(stdout) {
  const p = parsePayload(stdout) ?? {};
  const map = p.plans ?? (p.provider ? { [p.provider]: p } : {});
  return PLAN_PROVIDERS.map(k => map[k])
    .filter(pl => pl && pl.id !== "none" && n(pl.monthlyUsd) > 0)
    .map(pl => ({ id: pl.id, provider: pl.provider, monthlyUsd: n(pl.monthlyUsd), resetDay: pl.resetDay }));
}

// Preset plans keep codeburn's names; a custom one is named by its price ("Codex $100/mo").
export function planName(plan, currency) {
  return PLAN_NAMES[plan.id] ?? `${PROVIDER_LABELS[plan.provider] ?? plan.provider} ${fmtBudget(plan.monthlyUsd, currency)}/mo`;
}

const pad = x => String(x).padStart(2, "0");
export const localDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayAt = (d, plus) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + plus);
const dayIndex = d => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / MS_DAY);
const diffDays = (from, to) => dayIndex(to) - dayIndex(from);

// The budget window: from the reset day (1-28) at local midnight to the same day next month.
export function planPeriod(resetDay, now) {
  const day = Number.isInteger(resetDay) ? Math.min(28, Math.max(1, resetDay)) : 1;
  const y = now.getFullYear(), m = now.getMonth();
  return now.getDate() >= day
    ? { start: new Date(y, m, day), end: new Date(y, m + 1, day) }
    : { start: new Date(y, m - 1, day), end: new Date(y, m, day) };
}

// The days codeburn's projection looks at: the period's last (up to) 7 days, today included.
function trailingDays(start, now) {
  const count = Math.min(TRAILING_DAYS, Math.max(1, diffDays(start, now) + 1));
  return Array.from({ length: count }, (_, i) => localDate(dayAt(now, i - count + 1)));
}

// What to ask codeburn for: per period start, the range up to yesterday (today comes from the live
// Today payload), and each past day of the projection window.
export function planNeeds(plans, now) {
  const today = localDate(now), yesterday = localDate(dayAt(now, -1));
  const ranges = {}, days = new Set();
  for (const plan of plans) {
    if (plan.provider === "copilot") continue;
    const { start } = planPeriod(plan.resetDay, now);
    if (localDate(start) !== today) ranges[localDate(start)] = yesterday;
    for (const d of trailingDays(start, now)) if (d !== today) days.add(d);
  }
  return { ranges, days: [...days].sort(), copilot: plans.some(p => p.provider === "copilot") };
}

// Per device, only what plan math reads: its cost per provider.
export function slimProviders(payload) {
  return { devices: devicesOf(payload).map(d => ({ id: d.id, name: d.name, local: d.local, ...(d.error ? { error: d.error } : {}), ...(d.cachedAt ? { cachedAt: d.cachedAt } : {}), providers: d.payload?.current?.providers ?? null })) };
}

// A range or day entry's devices that were unreachable this time keep their providers from `prev`
// (the entry it replaces), marked `cachedAt` as in carryOver.
export function carryProviders(prev, next) {
  const old = new Map((prev?.data?.devices ?? []).map(d => [d.id, d]));
  return { devices: next.devices.map(d => {
    const o = old.get(d.id);
    return d.error && o?.providers ? { ...d, providers: o.providers, cachedAt: o.cachedAt ?? prev.at } : d;
  }) };
}

// One provider's cost over the reachable devices and the offline ones with cached numbers
// ("all": every provider). `cachedAt` is the oldest cached number used.
export function providerSpend(data, provider) {
  let cost = 0, offline = 0, missing = !data, cachedAt = null;
  for (const d of data?.devices ?? []) {
    if (d.error && !d.cachedAt) { offline += 1; continue; }
    if (!d.providers) { missing = true; continue; }
    if (d.cachedAt) cachedAt = Math.min(cachedAt ?? d.cachedAt, d.cachedAt);
    cost += provider === "all" ? Object.values(d.providers).reduce((a, v) => a + n(v), 0) : n(d.providers[provider]);
  }
  return { cost, offline, missing, cachedAt };
}

function median(values) {
  const s = [...values].sort((a, b) => a - b), mid = Math.floor(s.length / 2);
  return s.length === 0 ? 0 : s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const planStatus = percent => percent > 100 ? "over" : percent >= NEAR_PCT ? "near" : "under";

// One row per plan. `cache` is the mod's plan cache ({plans, ranges, days, copilot}); `today` the
// Today payload. `incomplete` marks a row that still waits for some of its numbers.
export function planUsages(cache, today, now, currency = { rate: 1 }) {
  const todayKey = localDate(now), yesterday = localDate(dayAt(now, -1));
  // A Today payload from before midnight is yesterday's: it counts for nothing today.
  const label = today?.current?.label?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const todayData = today && (!label || label === todayKey) ? slimProviders(today) : null;
  return (cache?.plans ?? []).map(plan => {
    const base = { plan, name: planName(plan, currency), provider: plan.provider, budget: plan.monthlyUsd };
    if (plan.provider === "copilot") {
      const c = cache.copilot?.plan, rate = n(currency.rate) || 1;
      if (!c) return { ...base, localOnly: true, incomplete: true, spent: 0, percent: 0, status: "under", ratio: 0, projected: 0, daysUntilReset: null, periodEnd: null, offline: 0, cachedAt: null };
      // codeburn's json output is in the display currency; the mod keeps USD.
      return { ...base, localOnly: true, incomplete: false, spent: n(c.spent) / rate, budget: n(c.budget) / rate,
        percent: n(c.percentUsed), status: c.status ?? planStatus(n(c.percentUsed)), ratio: n(c.spent) / Math.max(n(c.budget), 1),
        projected: n(c.projectedMonthEnd) / rate, daysUntilReset: c.daysUntilReset ?? null,
        periodEnd: c.periodEnd ? new Date(c.periodEnd) : null, offline: 0, cachedAt: null };
    }
    const { start, end } = planPeriod(plan.resetDay, now);
    const startKey = localDate(start);
    const todaySpend = providerSpend(todayData, plan.provider), sources = [todaySpend];
    let spent = todaySpend.cost;
    if (startKey !== todayKey) {
      const r = cache.ranges?.[startKey], s = providerSpend(r?.data, plan.provider);
      if (r?.to !== yesterday) s.missing = true;  // yesterday's range: one day short until refreshed
      sources.push(s);
      spent += s.cost;
    }
    const dayCosts = trailingDays(start, now).map(d => {
      if (d === todayKey) return todaySpend.cost;
      const s = providerSpend(cache.days?.[d]?.data, plan.provider);
      sources.push(s);
      return s.cost;
    });
    const daysUntilReset = Math.max(0, diffDays(now, end));
    const percent = plan.monthlyUsd > 0 ? spent / plan.monthlyUsd * 100 : 0;
    return {
      ...base, localOnly: false, spent, percent, status: planStatus(percent),
      ratio: spent / Math.max(plan.monthlyUsd, 1),
      projected: spent + median(dayCosts) * Math.max(0, daysUntilReset - 1),
      daysUntilReset, periodEnd: end,
      offline: Math.max(0, ...sources.map(s => s.offline)),
      cachedAt: sources.reduce((a, s) => s.cachedAt && (a === null || s.cachedAt < a) ? s.cachedAt : a, null),
      incomplete: sources.some(s => s.missing),
    };
  });
}

// A budget: whole amounts without cents ("$100").
export function fmtBudget(usd, currency = { symbol: "$", rate: 1 }) {
  const c = n(usd) * n(currency.rate || 1), s = currency.symbol ?? "$";
  return Math.abs(c - Math.round(c)) < 0.005 ? `${s}${Math.round(c).toLocaleString("en-US")}` : fmtCost(usd, currency);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtShortDate = d => `${MONTHS[d.getMonth()]} ${d.getDate()}`;

export function fmtTokens(x) {
  x = n(x);
  if (x >= 1e9) return `${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `${(x / 1e6).toFixed(2)}M`;
  if (x >= 1e4) return `${Math.round(x / 1e3)}k`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(1)}k`;
  return String(Math.round(x));
}

export const fmtCount = x => Math.round(n(x)).toLocaleString("en-US");

// codeburn's costs are USD; the currency it reports converts them, as its own formatCost does.
export function fmtCost(usd, currency = { symbol: "$", rate: 1 }) {
  const c = n(usd) * n(currency.rate || 1), s = currency.symbol ?? "$";
  if (c === 0) return `${s}0`;
  if (c >= 1000) return `${s}${Math.round(c).toLocaleString("en-US")}`;
  if (c >= 1) return `${s}${c.toFixed(2)}`;
  if (c >= 0.01) return `${s}${c.toFixed(3)}`;
  return `${s}${c.toFixed(4)}`;
}

export function fmtAgo(at, now) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const tildify = (path, home) => (home && path?.startsWith(home) ? "~" + path.slice(home.length) : path ?? "");
