// Plain logic for the codeburn usage panel: no imports, so Node can drive it directly.
// Input is one `codeburn status --format menubar-json --scope combined --combined-details` payload.

// [codeburn --period, chip label]. codeburn's "all" is only the last 6 months; "lifetime" is all.
export const RANGES = [["today", "Today"], ["week", "7 days"], ["30days", "30 days"], ["lifetime", "All"]];
export const ALL = "all";

const ZERO = { cost: 0, calls: 0, sessions: 0, inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
const n = x => (typeof x === "number" && isFinite(x) ? x : 0);

export function codeburnArgs(period) {
  return ["status", "--format", "menubar-json", "--scope", "combined", "--combined-details",
    "--period", period, "--no-optimize", "--no-timeline"];
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
      ...pick(c, ["label", "cost", "calls", "sessions", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]),
      topModels: (c.topModels ?? []).map(model),
      topProjects: (c.topProjects ?? []).map(p => pick(p, ["id", "name", "cost", "sessions"])),
    },
    currency: payload?.currency,
    ...(payload?.combined ? { combined: { perDevice: payload.combined.perDevice } } : {}),
    ...(payload?.combinedDevices ? {
      combinedDevices: payload.combinedDevices.map(d => ({
        ...pick(d, ["id", "name", "local", "error"]),
        ...(!d.local && d.payload ? { payload: { current: { topModels: (d.payload.current?.topModels ?? []).map(model) } } } : {}),
      })),
    } : {}),
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
    id: d.id, name: d.name, local: !!d.local, error: d.error,
    totals: { ...ZERO, ...Object.fromEntries(Object.keys(ZERO).map(k => [k, n(d[k])])) },
    payload: d.local ? payload : details.get(d.id),
  }));
}

// What the panel shows for one device id, or ALL for every reachable one.
export function summarize(payload, device = ALL) {
  const devices = devicesOf(payload);
  const chosen = devices.find(d => d.id === device);
  const picked = chosen ? [chosen] : devices.filter(d => !d.error);
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
    hitRate: totals.inputTokens + totals.cacheReadTokens > 0
      ? totals.cacheReadTokens / (totals.inputTokens + totals.cacheReadTokens) : 0,
    label: payload?.current?.label ?? "",
    currency: payload?.currency ?? { code: "USD", symbol: "$", rate: 1 },
  };
}

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
