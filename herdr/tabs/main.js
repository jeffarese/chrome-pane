// Chrome's tabs, as a list that drops from the pane header's tabs button (or Ctrl+T in the pane):
// type to find one, ↑/↓ and Enter to show it in the pane, × (or Ctrl+D, twice) to close it in
// Chrome, and what you typed opens in a new tab when no tab is meant.
//
// Opened by chrome-bar.js with props { cli, on, terminal, tab }: the viewer's own program and the
// computer it runs on, the pane's terminal there, and the tab the pane shows. The list is
// chrome-pane's (`tabs --json`), and what is picked goes to the pane's viewer
// (`bar --in <terminal> show|close-tab|new`).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { exec, theme, props, closeOverlay, checking } from "herdr";

const ROW = 44, SHOWN = 9;
const TILES = ["#5b8def", "#22a99a", "#e3814f", "#8b7cf6", "#3fae6a", "#d9649a", "#c9a227", "#4aa3c7"];

/** A tab's address as a site and what follows it, as a browser's bar writes it. */
function parts(url) {
  const a = String(url ?? "").replace(/^https:\/\//i, "");
  const m = /^([a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)(.*)$/i.exec(a);
  if (!m || !m[2] || /^(about|data|blob|chrome|view-source|javascript):/i.test(a)) return { site: a, rest: "" };
  return { site: (m[1] ?? "") + m[2], rest: m[3] === "/" ? "" : m[3] };
}

/** The site's name without what every site has: the letter on its tile comes from it. */
const bare = (site) => site.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "");

function hash(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}

export default class ChromeTabs extends View {
  init(_props, cx) {
    this.tabs = null;        // Chrome's tabs, once chrome-pane said them
    this.error = "";
    this.filter = "";
    this.at = null;          // the row the keys are on
    this.hover = null;       // the tab under the mouse: its × shows
    this.asked = null;       // the tab whose × was pressed once: again closes it
    this.gone = new Set();   // closed here, and not yet gone from Chrome's list
    this.scroll = ScrollHandle.new();
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Find a tab, or type an address" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      this.asked = null;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.go(this.rows()[this.at ?? 0], cx));
    this.input.focus();
    if (checking()) return;
    cx.timer.after(400, () => this.input.focus());
    this.load(cx);
    // A tab opened, closed or renamed in Chrome meanwhile.
    cx.timer.every(2500, (cx) => this.load(cx));
  }

  run(args) {
    const p = props();
    return exec(p.cli[0], [...p.cli.slice(1), ...args], { on: p.on ?? null, timeout: 8000 });
  }

  /** One action of the pane's viewer. */
  send(act, arg) {
    return this.run(["bar", "--in", props().terminal, act, ...(arg == null ? [] : [String(arg)])]).catch(() => {});
  }

  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await this.run(["tabs", "--json"]);
        if (r.code !== 0) throw new Error((r.stderr || "").trim().split("\n").pop() || "chrome-pane could not list Chrome's tabs");
        this.tabs = JSON.parse(r.stdout);
        this.error = "";
        for (const id of this.gone) if (!this.tabs.some((t) => t.id === id)) this.gone.delete(id);
      } catch (e) {
        if (!this.tabs) this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  /** What the list shows: the tabs that have every word typed, then what else Enter can do. */
  rows() {
    const words = this.filter.toLowerCase().split(/\s+/).filter(Boolean);
    const tabs = (this.tabs ?? []).filter((t) => !this.gone.has(t.id))
      .filter((t) => words.every((w) => `${t.title} ${t.url}`.toLowerCase().includes(w)))
      .map((t) => ({ kind: "tab", id: t.id, tab: t }));
    const typed = this.filter.trim();
    return [...tabs, typed ? { kind: "open", id: "open", text: typed } : { kind: "new", id: "new" }];
  }

  close() {
    closeOverlay(props().overlay);
  }

  go(row, _cx) {
    if (!row) return;
    this.close();
    if (row.kind === "tab") this.send("show", row.id);
    else this.send("new", row.kind === "open" ? row.text : null);
  }

  /** The first time asks, the second closes: it is a tab of the person's real Chrome. */
  shut(row, cx) {
    if (row?.kind !== "tab") return;
    if (this.asked !== row.id) this.asked = row.id;
    else {
      this.asked = null;
      this.gone.add(row.id);
      this.send("close-tab", row.id).then(() => {});
    }
    this.input.focus();
    cx.notify();
  }

  tile(t, site) {
    const name = bare(site);
    // A site keeps its colour: the same in a light theme and a dark one, as a site's own icon is.
    const color = name ? TILES[hash(name) % TILES.length] : t.dim;
    return h_flex().size(26).flex_none().rounded(7).items_center().justify_center()
      .bg(color).text_color("#ffffff").text_size(12.5).font_bold()
      .child(([...name][0] ?? "·").toUpperCase());
  }

  row(t, r, on) {
    const base = h_flex()
      .id(`ct-${r.id}`)
      .h(ROW)
      .flex_none()
      .mx(6)
      .px(8)
      .gap(10)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .when(on, (el) => el.bg(t.selected))
      .hover((s) => s.bg(on ? t.selected : t.hover))
      .on_click((_e, cx) => this.go(r, cx));
    if (r.kind !== "tab") {
      const label = r.kind === "new" ? "New tab" : `Open “${r.text}” in a new tab`;
      return base
        .child(h_flex().size(26).flex_none().rounded(7).items_center().justify_center().bg(t.foreground + "12").text_color(t.muted)
          .child(svg("mods/chrome-pane-tabs/plus.svg").size(14)))
        .child(div().flex_1().min_w(0).truncate().text_color(on ? t.foreground : t.muted).child(label));
    }
    const a = parts(r.tab.url);
    const here = r.id === props().tab;
    const asked = this.asked === r.id;
    return base
      .on_hover((hovered, cx) => {
        if (hovered) this.hover = r.id;
        else if (this.hover === r.id) this.hover = null;
        cx.notify();
      })
      .child(this.tile(t, a.site))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_color(t.foreground).when(here, (el) => el.font_semibold()).child(r.tab.title || a.site || "Untitled"))
        .child(h_flex().min_w(0).text_size(11)
          .child(div().flex_shrink(1).min_w(0).truncate().text_color(t.muted).child(a.site))
          .when(Boolean(a.rest), (el) => el.child(div().flex_shrink(1000).min_w(0).truncate().text_color(t.dim).child(a.rest)))))
      .when(here && !asked, (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5)
        .bg(t.accent + "26").text_size(10.5).font_semibold().text_color(t.accent).child("In this pane")))
      .when(asked, (el) => el.child(div()
        .id(`ct-shut-${r.id}`).flex_none().px(8).h(22).flex().items_center().rounded(6)
        .bg(t.blocked + "2b").text_size(11).font_semibold().text_color(t.blocked)
        .hover((s) => s.bg(t.blocked + "45"))
        .on_click((_e, cx) => { cx.stop_propagation(); this.shut(r, cx); })
        .child("Close tab")))
      .when(!asked && (this.hover === r.id || on), (el) => el.child(div()
        .id(`ct-x-${r.id}`).flex_none().p(4).rounded(5).text_color(t.dim)
        .tooltip("Close this tab in Chrome")
        .hover((s) => s.bg(t.foreground + "1a").text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); this.shut(r, cx); })
        .child(svg("mods/chrome-pane-tabs/x.svg").size(13))));
  }

  render() {
    const t = theme();
    const rows = this.rows();
    if (this.at === null && this.tabs) this.at = Math.max(0, rows.findIndex((r) => r.id === props().tab));
    const at = Math.min(this.at ?? 0, rows.length - 1);
    const count = (this.tabs ?? []).filter((x) => !this.gone.has(x.id)).length;
    const found = rows.length - 1;
    const hint = (keys, what) => h_flex().gap(4).items_center()
      .child(div().px(4).h(16).flex().items_center().rounded(4).bg(t.foreground + "12").text_color(t.muted).child(keys))
      .child(div().text_color(t.dim).child(what));
    const move = (to, cx) => {
      this.at = (to + rows.length) % rows.length;
      this.asked = null;
      this.scroll.scroll_to_item(this.at);
      cx.stop_propagation();
      cx.notify();
    };

    return v_flex()
      .id("chrome-tabs")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .pt(8)
      .gap(6)
      .bg(t.popover)
      .text_size(12.5)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") {
          cx.stop_propagation();
          if (this.asked) { this.asked = null; return cx.notify(); }
          return this.close();
        }
        if (k === "down") return move(at + 1, cx);
        if (k === "up") return move(at - 1, cx);
        if (k === "d" && e.modifiers.control) {
          cx.stop_propagation();
          return this.shut(rows[at], cx);
        }
      })
      .child(h_flex().mx(8).h(34).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/chrome-pane-tabs/search.svg").size(14).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground))
        .when(this.tabs !== null, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim)
          .child(this.filter.trim() ? `${found} of ${count}` : `${count} tab${count === 1 ? "" : "s"}`))))
      .when(this.tabs === null && !this.error, (el) => el.child(h_flex().h(ROW).px(16).gap(8).items_center().text_color(t.dim)
        .child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().spin(900))
        .child("Asking Chrome for its tabs…")))
      .when(Boolean(this.error), (el) => el.child(div().px(16).py(10).text_color(t.blocked).child(this.error)))
      .when(this.tabs !== null, (el) => el.child(v_flex()
        .id("ct-list")
        .track_scroll(this.scroll)
        .h(Math.min(SHOWN, rows.length) * (ROW + 2))
        .flex_none()
        .gap(2)
        .overflow_y_scrollbar()
        .children(rows.map((r, i) => this.row(t, r, i === at)))))
      .child(h_flex().h(28).flex_none().px(14).gap(12).items_center().border_t(1).border_color(t.border).text_size(10.5)
        .child(hint("↑↓", "move"))
        .child(hint("Enter", "show"))
        .child(hint("Ctrl+D", "close tab"))
        .child(div().flex_1())
        .child(hint("Esc", "leave")));
  }
}
