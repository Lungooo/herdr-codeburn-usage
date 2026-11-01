// Token usage from codeburn: totals, models and devices across every paired device.
// One `codeburn status --scope combined --combined-details` per refresh; codeburn does the indexing.
// Each range's last answer is kept in shared state (memory, saved by Herdr), so the dialog opens
// with numbers at once and the status strip keeps today warm for it.
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme, shared, setShared, home, props, run, closeOverlay } from "herdr";
import { RANGES, ALL, codeburnArgs, parsePayload, slim, summarize, fmtTokens, fmtCount, fmtCost, fmtAgo, tildify } from "./store.js";

const TICK = 15000, STALE = 60000;
const MODELS = 12, PROJECTS = 10;
// Fixed numeric columns so rows line up in a proportional UI font.
const COL = { req: 56, tokens: 84, cost: 76 };

// The status-bar copy (layout props `{"bar": true}`) always shows today, every device.
const isBar = () => !!props()?.bar;
const range = () => isBar() ? "today" : (RANGES.some(([k]) => k === shared("codeburn-usage.range")) ? shared("codeburn-usage.range") : "today");
const device = () => isBar() ? ALL : shared("codeburn-usage.device") ?? ALL;

// { payload (slimmed), at } per range, written by whichever copy fetched it last.
const cacheKey = period => `codeburn-usage.cache.${period}`;
const OPEN = "codeburn-usage.dialog-open", PAUSE_MAX = 5 * 60000;
const cached = period => {
  const c = shared(cacheKey(period));
  return c?.payload && typeof c.at === "number" ? c : null;
};

async function runCodeburn(period) {
  const args = codeburnArgs(period);
  try {
    return await exec("codeburn", args);
  } catch (e) {
    // Not on the app's PATH (an nvm or npm-prefix install): ask the login shell.
    const line = ["codeburn", ...args].join(" ");
    return exec("sh", ["-c", `exec "\${SHELL:-/bin/sh}" -lic '${line}' </dev/null`])
      .catch(e2 => ({ code: -1, stdout: "", stderr: String(e2 ?? e) }));
  }
}

export default class CodeburnUsage extends View {
  // While the dialog is open every whole-window redraw is slow (0.5–1 s measured), so nothing
  // redraws on its own then: the dialog has no clock, and the strip pauses its refresh.
  init(_props, cx) {
    this.errors = {};    // period -> last refresh error (the cached numbers stay)
    this.busy = null;    // period being fetched
    this.again = false;  // Refresh pressed while busy
    // OPEN is { id, at } of the open dialog; close() is best-effort, so a stale mark expires on its own.
    if (isBar()) {
      setShared(OPEN, null);
      cx.timer.every(TICK, cx => { if (Date.now() - (shared(OPEN)?.at ?? 0) > PAUSE_MAX) this.maybeRefresh(cx); });
    } else {
      // The key toggles: opening while one is open closes both. A mark left by a dialog that is
      // already gone (Herdr quit with it open) costs one extra press, since it is cleared here too.
      const prev = shared(OPEN)?.id, id = props()?.overlay;
      if (prev && prev !== id) {
        closeOverlay(prev);
        closeOverlay(id);
        setShared(OPEN, null);
      } else setShared(OPEN, { id, at: Date.now() });
    }
    this.maybeRefresh(cx);
  }

  async close() {
    // Only the current dialog clears the mark; one closed by its replacement leaves it alone.
    if (!isBar() && shared(OPEN)?.id === props()?.overlay) setShared(OPEN, null);
  }

  maybeRefresh(cx) {
    const c = cached(range());
    if (!this.busy && (!c || Date.now() - c.at > STALE)) this.refresh(cx);
  }

  refresh(cx, force = false) {
    if (this.busy) { this.again = this.again || force; return; }
    const period = range();
    // Another copy may have just fetched it.
    if (!force && cached(period) && Date.now() - cached(period).at <= STALE) return;
    // No redraw to say "refreshing": one redraw when the numbers arrive.
    this.busy = period;
    cx.spawn(async cx => {
      const r = await runCodeburn(period);
      let payload = null, error = null;
      if (r.code !== 0) error = (r.stderr || r.stdout || `codeburn exited ${r.code}`).trim().split("\n").pop();
      else try { payload = parsePayload(r.stdout); } catch (e) { error = `unreadable codeburn output: ${e}`; }
      if (!payload && !error) error = "codeburn printed nothing";
      this.errors[period] = error;
      if (payload) setShared(cacheKey(period), { at: Date.now(), payload: slim(payload) });
      this.busy = null;
      if (this.again || period !== range()) { const again = this.again; this.again = false; this.refresh(cx, again); }
      cx.notify();
    });
  }

  render(cx) {
    this.now = Date.now();
    const t = theme();
    const period = range();
    const c = cached(period);
    const entry = c || this.errors[period] ? { at: c?.at, error: this.errors[period] ?? null } : null;
    const s = c ? summarize(c.payload, device()) : null;
    if (isBar()) return this.strip(t, entry, s);
    if (entry?.at) this.tickStamp(entry.at, cx);

    return v_flex().id("root").size_full().bg(t.surface).text_color(t.foreground)
      .child(this.header(t, entry))
      .child(this.chips(t, period))
      .child(s ? this.body(t, s) : this.empty(t, entry))
      .child(this.footer(t, entry, s));
  }

  // One line in the status bar: today's spend and tokens over every device. Click for the panel.
  strip(t, entry, s) {
    const stale = !entry?.at || this.now - entry.at > 3 * STALE;
    const tip = s
      ? s.devices.map(d => `${d.name}: ${d.error ? `unreachable (${d.error})` : `${fmtCost(d.totals.cost, s.currency)} · ${fmtTokens(d.totals.totalTokens)}`}`).join("\n")
      : entry?.error ?? "codeburn usage";
    // The content measures itself and the block is resized to it: 11 px left, then 11 px and a
    // 1 px separator on the right (the quota strip adds its own 11 px after it).
    const content = h_flex().id("codeburn-strip-content").flex_none().gap(6).items_center()
      .on_size_change(size => this.fitStrip(size.width))
      .child(div().flex_none().text_size(10).text_color(t.dim).child("Today"))
      .when(!s, el => el.child(div().flex_none().text_color(entry?.error ? t.blocked : t.dim)
        .child(entry?.error ? "codeburn unavailable" : "…")))
      .when(!!s, el => el
        .child(div().flex_none().text_color(s.totals.cost > 0 ? t.done : t.dim).child(fmtCost(s.totals.cost, s.currency)))
        .child(div().flex_none().text_color(t.dim).child("·"))
        .child(div().flex_none().child(fmtTokens(s.totals.totalTokens)))
        .when(s.reachable < s.devices.length, el => el.child(div().flex_none().text_color(t.blocked)
          .child(`${s.devices.length - s.reachable} offline`))));
    return h_flex().id("codeburn-strip").size_full().pl(11).gap(11).items_center().overflow_hidden()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.5).text_color(t.muted).cursor_pointer()
      .when(stale, el => el.opacity(0.6))
      .tooltip(`${tip}\nClick for details (ctrl-shift-u)`)
      .on_click(() => run("mod.open", { name: "codeburn-usage" }))
      .child(content)
      .child(div().flex_none().w(1).h(12).bg(t.border));
  }

  fitStrip(width) {
    const px = Math.ceil(width) + 11 + 11 + 1;
    if (Math.abs(px - (this.px ?? 0)) < 1) return;
    this.px = px;
    try { run("layout.resize", { id: props()?.block ?? "status-codeburn", px }); }
    catch (e) { console.log(`codeburn-usage: resize failed: ${e}`); }
  }

  // The "x ago" stamp redraws only when its text changes: each second for the first minute, then
  // each minute, then each hour. One pending tick at a time; a newer one cancels the older.
  tickStamp(at, cx) {
    const now = Date.now(), age = Math.max(0, now - at);
    const unit = age < 60000 ? 1000 : age < 3600000 ? 60000 : 3600000;
    const due = now + unit - (age % unit) + 20;
    if (this.stampDue > now && this.stampDue <= due) return;
    this.stampDue = due;
    const gen = this.stampGen = (this.stampGen ?? 0) + 1;
    cx.timer.after(due - now, cx => { if (gen === this.stampGen) { this.stampDue = 0; cx.notify(); } });
  }

  header(t, entry) {
    const stamp = entry?.at ? fmtAgo(entry.at, this.now) : this.busy ? "loading…" : "waiting";
    return h_flex().flex_none().h(40).px(16).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().flex_none().text_size(13).font_semibold().child("Token usage"))
      .child(div().flex_1().min_w(0).truncate().text_right().text_size(11.5).text_color(t.dim)
        .child(this.busy && entry?.at ? `refreshing · ${stamp}` : stamp))
      .child(h_flex().id("refresh").flex_none().h(22).px(9).rounded(6).items_center()
        .bg(t.raised).text_size(11.5).text_color(t.muted)
        .hover(st => st.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.refresh(cx, true))
        .child("Refresh"));
  }

  chips(t, period) {
    return h_flex().flex_none().px(16).py(8).gap(6).flex_wrap().children(RANGES.map(([key, label]) => {
      const on = key === period;
      return h_flex().id(`range-${key}`).h(22).px(10).rounded(11).items_center().text_size(11.5)
        .bg(on ? t.selected : t.raised).text_color(on ? t.foreground : t.muted).cursor_pointer()
        // Themes may make `hover` the same as `raised` (noctalia does), so hover uses `selected`.
        .hover(st => on ? st.text_color(t.accent) : st.bg(t.selected).text_color(t.foreground))
        .on_click((_e, cx) => {
          setShared("codeburn-usage.range", key);
          this.maybeRefresh(cx);
        })
        .child(label);
    }));
  }

  empty(t, entry) {
    const text = this.busy ? "Asking codeburn…"
      : entry?.error ? `codeburn failed: ${entry.error}` : "No codeburn data yet";
    return v_flex().flex_1().px(16).py(8).text_size(11.5).text_color(t.dim).child(text);
  }

  body(t, s) {
    const cur = s.currency;
    const tile = (label, value, color) => v_flex().flex_1().min_w(0).gap(1)
      .child(div().text_size(11.5).text_color(t.dim).truncate().child(label))
      .child(div().text_size(14).truncate().text_color(color ?? t.foreground).child(value));
    const row = (...tiles) => h_flex().gap(16).children(tiles);
    const T = s.totals;

    return v_flex().id("scroll").flex_1().min_h(0).overflow_y_scrollbar().px(16).pb(12).gap(10)
      .child(this.scope(t, s))
      .child(row(tile("Total tokens", fmtTokens(T.totalTokens)), tile("Input", fmtTokens(T.inputTokens)), tile("Output", fmtTokens(T.outputTokens))))
      .child(row(tile("Cache read", fmtTokens(T.cacheReadTokens)), tile("Requests", fmtCount(T.calls)), tile("Cost", fmtCost(T.cost, cur), T.cost > 0 ? t.done : t.dim)))
      .child(h_flex().gap(8).items_center().text_size(11.5)
        .child(div().flex_none().text_color(t.dim).child("Cache hit rate"))
        .child(this.bar(t, s.hitRate).flex_1())
        .child(div().flex_none().w(46).text_right().child(`${(s.hitRate * 100).toFixed(1)}%`)))
      .child(this.models(t, s))
      .child(this.devices(t, s))
      .when(s.projects !== null, el => el.child(this.projects(t, s)));
  }

  // Which devices the numbers are about; a click on a device row narrows to it.
  scope(t, s) {
    const label = s.chosen
      ? `${s.chosen.name}${s.chosen.local ? " (this device)" : ""}`
      : `All devices · ${s.reachable} of ${s.devices.length} reachable`;
    return h_flex().gap(8).items_center().text_size(11.5).pt(2)
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(`${s.label} · ${label}`))
      .when(!!s.chosen, el => el.child(h_flex().id("scope-all").flex_none().h(22).px(10).rounded(11).items_center()
        .bg(t.raised).text_color(t.muted).hover(st => st.bg(t.hover).text_color(t.foreground))
        .on_click(() => setShared("codeburn-usage.device", ALL))
        .child("All devices")));
  }

  bar(t, share) {
    const pct = Math.max(0, Math.min(1, share)) * 100;
    return div().h(3).rounded(2).bg(t.raised).child(div().h(3).rounded(2).bg(t.accent).w(`${pct}%`));
  }

  title(t, text) {
    return div().pt(6).text_size(12.5).font_semibold().child(text);
  }

  numHeader(t, first, cols) {
    return h_flex().gap(4).text_size(11).text_color(t.dim)
      .child(div().flex_1().min_w(0).truncate().child(first))
      .children(cols.map(([w, label]) => div().flex_none().w(w).text_right().child(label)));
  }

  models(t, s) {
    const total = s.models.reduce((a, m) => a + m.tokens, 0);
    const rows = s.models.slice(0, MODELS);
    return v_flex().gap(4)
      .child(this.title(t, s.models.length > MODELS ? `Models · top ${MODELS} of ${s.models.length}` : "Models"))
      .child(this.numHeader(t, "Model", [[COL.req, "Req"], [COL.tokens, "Tokens"], [COL.cost, "Cost"]]))
      .when(rows.length === 0, el => el.child(div().text_size(11.5).text_color(t.dim).child("No model data in this range")))
      .children(rows.map(m => v_flex().gap(2)
        .child(h_flex().gap(4).text_size(12)
          .child(div().flex_1().min_w(0).truncate().child(m.name))
          .child(div().flex_none().w(COL.req).text_right().text_color(t.muted).child(fmtCount(m.calls)))
          .child(div().flex_none().w(COL.tokens).text_right().child(fmtTokens(m.tokens)))
          .child(div().flex_none().w(COL.cost).text_right().text_color(m.cost > 0 ? t.done : t.dim).child(fmtCost(m.cost, s.currency))))
        .child(this.bar(t, total ? m.tokens / total : 0))));
  }

  devices(t, s) {
    const total = s.devices.reduce((a, d) => a + (d.error ? 0 : d.totals.totalTokens), 0);
    return v_flex().gap(4)
      .child(this.title(t, "Devices"))
      .child(this.numHeader(t, "Device", [[COL.req, "Req"], [COL.tokens, "Tokens"], [COL.cost, "Cost"]]))
      .children(s.devices.map((d, i) => {
        const on = s.chosen?.id === d.id;
        return v_flex().id(`device-${i}`).gap(2).px(4).py(2).rounded(4)
          .when(on, el => el.bg(t.selected))
          .hover(st => st.bg(on ? t.selected : t.hover))
          .on_click(() => setShared("codeburn-usage.device", on ? ALL : d.id))
          .child(h_flex().gap(4).text_size(12)
            .child(h_flex().flex_1().min_w(0).gap(5)
              .child(div().min_w(0).truncate().text_color(d.error ? t.dim : t.foreground).child(d.name))
              .when(d.local, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child("this device"))))
            .when(!d.error, el => el
              .child(div().flex_none().w(COL.req).text_right().text_color(t.muted).child(fmtCount(d.totals.calls)))
              .child(div().flex_none().w(COL.tokens).text_right().child(fmtTokens(d.totals.totalTokens)))
              .child(div().flex_none().w(COL.cost).text_right().text_color(d.totals.cost > 0 ? t.done : t.dim)
                .child(fmtCost(d.totals.cost, s.currency)))))
          .child(d.error
            ? div().text_size(11).text_color(t.blocked).truncate().child(`unreachable: ${d.error}`)
            : this.bar(t, total ? d.totals.totalTokens / total : 0));
      }));
  }

  projects(t, s) {
    const rows = s.projects.slice(0, PROJECTS), h = home();
    return v_flex().gap(2)
      .child(this.title(t, "Projects · this device"))
      .child(this.numHeader(t, "Project", [[COL.req + COL.tokens, "Sessions"], [COL.cost, "Cost"]]))
      .when(rows.length === 0, el => el.child(div().text_size(11.5).text_color(t.dim).child("No project data in this range")))
      .children(rows.map(p => h_flex().h(20).gap(4).items_center().text_size(12)
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(tildify(p.path, h)))
        .child(div().flex_none().w(COL.req + COL.tokens).text_right().text_color(t.dim).child(fmtCount(p.sessions)))
        .child(div().flex_none().w(COL.cost).text_right().text_color(p.cost > 0 ? t.done : t.dim).child(fmtCost(p.cost, s.currency)))));
  }

  footer(t, entry, s) {
    let text;
    if (entry?.error && s) text = `Refresh failed, showing ${fmtAgo(entry.at, this.now)}: ${entry.error}`;
    else if (entry?.error) text = entry.error;
    else if (s) text = `${s.reachable}/${s.devices.length} devices · ${s.models.length} models · via codeburn · Esc closes`;
    else text = this.busy ? "Running codeburn status --scope combined" : "Not loaded";
    return h_flex().flex_none().h(28).px(16).items_center().border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(entry?.error ? t.blocked : t.dim).child(text));
  }
}
