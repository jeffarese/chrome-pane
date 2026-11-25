// Chrome's controls for a pane that shows chrome-pane's viewer, drawn by the pane's header:
// back, forward, reload or stop, the address as a real text field, and Chrome's tabs.
//
// The viewer says what its bar would show in a label on its terminal ("chrome-pane.bar", JSON),
// and takes what is clicked here through its own program: chrome-pane bar --in <terminal> <action>.
// While a header draws these, the viewer draws no bar of its own: the page has the whole pane.
//
// For a header mod of your own (`chrome-pane herdr --into <mod>` puts this file and its icons
// in that mod's folder):
//
//   import { ChromeBar } from "./chrome-bar.js";
//   init(_props, cx)  this.chrome = new ChromeBar("<mod>", cx);
//   render(cx)        if (this.chrome.see(term))      // term: the pane's entry in terminals()
//                       row.child(this.chrome.render(theme(), pane, cx));  // pane: its entry in panes()
//   close()           await this.chrome.close();      // the viewer puts its own bar back
import { div, svg } from "gpui-kit";
import { h_flex, InputState, Input } from "gpui-base";
import { exec, run, checking } from "herdr";

export const LABEL = "chrome-pane.bar";

/** What the viewer in that terminal says its bar shows; null when the pane is not a Chrome pane. */
export function chromeState(term) {
  const text = term?.labels?.[LABEL];
  if (!text) return null;
  let s = null;
  try { s = JSON.parse(text); } catch {}
  // own: the viewer was told to keep its own bar (--bar).
  if (!s || s.v !== 1 || !Array.isArray(s.cli) || s.own) return null;
  // A label outlives a viewer that was killed: the terminal's program must still be that viewer.
  const running = term.foreground?.pid;
  if (running != null && s.pid != null && running !== s.pid) return null;
  return s;
}

/** An address in pieces, as a browser's bar writes it: no https://, the site standing out. */
export function addressParts(url) {
  const a = String(url ?? "").replace(/^https:\/\//i, "").replace(/^((?:http:\/\/)?[^/?#]+)\/$/i, "$1");
  const m = /^([a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)(.*)$/i.exec(a);
  if (!m || !m[2] || /^(about|data|blob|chrome|view-source|javascript):/i.test(a)) return { scheme: "", site: a, rest: "" };
  return { scheme: m[1] ?? "", site: m[2], rest: m[3] };
}

export class ChromeBar {
  /** `mod`: the folder of the header mod this is part of; its icons are there. Made in the view's init, with its `cx`. */
  constructor(mod, cx) {
    this.mod = mod;
    // The viewer keeps its own bar away only while a header says, now and then, that it draws
    // the controls: a header that went without a word (the app was killed, the mod replaced)
    // is not waited for long.
    if (!checking()) cx.timer.every(30_000, () => { if (this.state) this.claim(); });
    this.state = null;      // what the viewer said last
    this.address = null;    // the pane's terminal
    this.pane = null;
    this.editing = false;
    this.focusSeen = null;  // the viewer's count of Ctrl+L, as last seen
    this.claimedAt = 0;
    this.claimedPid = null; // the viewer that was told this header draws its controls
    this.input = InputState.new({ placeholder: "Search, or type an address" });
    this.input.on("submit", (_e, cx) => {
      const url = this.input.value().trim();
      this.leave();
      if (url) this.send("go", url);
      cx.notify();
    });
    this.input.on("blur", (_e, cx) => {
      if (!this.editing) return;
      this.editing = false;
      cx.notify();
    });
  }

  /** Asks the pane's viewer for one action of its bar, on the computer the viewer runs on. */
  send(act, arg) {
    const s = this.state, address = this.address;
    if (!s || !address || checking()) return Promise.resolve();
    const cut = address.lastIndexOf("/");
    const args = [...s.cli.slice(1), "bar", "--in", address.slice(cut + 1), act];
    if (arg != null) args.push(String(arg));
    return exec(s.cli[0], args, { on: cut < 0 ? null : address.slice(0, cut), timeout: 8000 }).catch(() => {});
  }

  /** Tells the viewer that this header draws the controls. */
  claim() {
    this.claimedAt = Date.now();
    this.send("native", "on");
  }

  /**
   * Looks at the pane's terminal (its entry in terminals()): what its viewer says the bar shows,
   * or null when the pane does not show Chrome. Called on every render, before render().
   */
  see(term) {
    this.state = chromeState(term);
    this.address = this.state ? term.address : null;
    if (!this.state) { this.editing = false; this.focusSeen = null; }
    return this.state;
  }

  /** The address field takes the keyboard, the page's address selected in it. */
  begin() {
    const url = this.state?.url ?? "";
    this.editing = true;
    this.input.set_value(url);
    this.input.set_selected_range({ start: 0, end: url.length });
    this.input.focus();
  }

  /** The keyboard goes back to the page. */
  leave() {
    this.editing = false;
    this.input.blur();
    if (this.pane) run("pane.focus", { pane: this.pane });
  }

  /** The header is going: the viewer draws its own bar again. */
  async close() {
    if (this.state?.native) await this.send("native", "off");
  }

  icon(name) {
    return `mods/${this.mod}/cp-${name}.svg`;
  }

  button(t, id, name, tip, act, enabled = true) {
    return div()
      .id(id)
      .flex_none()
      .p(3)
      .rounded(4)
      .text_color(enabled ? t.muted : t.foreground + "33")
      .tooltip(tip)
      .when(enabled, (el) => el
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => { this.send(act); }))
      .child(svg(this.icon(name)).size(14));
  }

  /** A button with words on it, for what the page asks. */
  answer(t, id, label, act, main = false) {
    return div()
      .id(id)
      .flex_none()
      .h(20)
      .px(8)
      .flex()
      .items_center()
      .rounded(5)
      .text_size(11.5)
      .font_medium()
      .bg(main ? t.solid : t.foreground + "14")
      .text_color(main ? t.solid_foreground : t.foreground)
      .hover((s) => s.opacity(0.85))
      .on_click(() => { this.send(act); })
      .child(label);
  }

  /** A line the bar says in place of the address, with the buttons that answer it. */
  says(t, id, text, color, buttons = []) {
    return h_flex()
      .id(id)
      .flex_1()
      .min_w(0)
      .gap(6)
      .items_center()
      .child(div().flex_1().min_w(0).truncate().text_color(color).tooltip(text).child(text))
      .children(buttons);
  }

  field(t, pane, s) {
    const box = h_flex()
      .id(`cp-field-${pane}`)
      .flex_1()
      .min_w(0)
      .h(22)
      .px(8)
      .gap(6)
      .items_center()
      .rounded(6)
      .border_1();
    if (this.editing) {
      return box
        .bg(t.background)
        .border_color(t.accent)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => cx.stop_propagation())
        .on_key_down((e, cx) => {
          if (e.key !== "escape") return;
          cx.stop_propagation();
          this.leave();
          cx.notify();
        })
        .child(Input.new(this.input).flex_1().h_full().text_size(12).text_color(t.foreground));
    }
    box
      .bg(t.foreground + "0d")
      .border_color(t.foreground + "00")
      .hover((st) => st.bg(t.foreground + "14").border_color(t.input))
      .tooltip("Type an address, or search  ·  Ctrl+L")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.begin();
        cx.notify();
      });
    if (s.loading) box.child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.dim).spin(900));
    if (s.agent) {
      // An agent is acting on the page: what it does, then the page.
      box.child(div().size(6).flex_none().rounded(3).bg(t.working));
      box.child(div().flex_shrink(1).min_w(0).truncate().text_color(t.foreground).child(`Agent: ${s.agent}`));
      const about = s.title || addressParts(s.url).site;
      if (about) box.child(div().flex_shrink(100).min_w(0).truncate().text_color(t.dim).child(about));
      return box;
    }
    if (s.mode !== "page") return box.child(div().truncate().text_color(t.dim).child(s.mode === "tabs" ? "Choosing a tab in the pane…" : "Chrome"));
    const a = addressParts(s.url);
    // The site is the last to be cut: what follows it gives way first, the title before that.
    box.child(h_flex().flex_shrink(1).min_w(0).overflow_hidden()
      .when(Boolean(a.scheme), (el) => el.child(div().flex_none().text_color(t.dim).child(a.scheme)))
      .child(div().flex_shrink(1).min_w(0).truncate().text_color(t.foreground).child(a.site || s.title || ""))
      .when(Boolean(a.rest), (el) => el.child(div().flex_shrink(1000).min_w(0).truncate().text_color(t.muted).child(a.rest))));
    if (s.title && a.site) box.child(div().flex_shrink(100000).min_w(0).truncate().text_color(t.dim).child(s.title));
    return box;
  }

  /**
   * The controls, to put in the header's row in place of the pane's name and folder, once see()
   * said the pane shows Chrome. `t`: theme(), `p`: the pane's entry in panes(), `cx`: render's own.
   */
  render(t, p, cx) {
    const pane = p.pane, s = this.state;
    this.pane = pane;
    // The viewer draws its own bar until a header says it draws the controls; asked again
    // should the viewer go back to its own (another screen's header went).
    // A viewer just started is told at once, whatever it assumes: it waits a moment for this.
    if (!checking() && (s.pid !== this.claimedPid || (!s.native && Date.now() - this.claimedAt > 3000))) {
      this.claimedPid = s.pid;
      this.claim();
    }
    // Ctrl+L in the pane: the viewer counts them, and this field is the one to type in.
    if (this.focusSeen === null) this.focusSeen = s.focus;
    else if (s.focus !== this.focusSeen) {
      this.focusSeen = s.focus;
      // Not from here: a field takes the keyboard between two renders, never during one.
      if (s.mode === "page" && !this.editing) cx.spawn(async (cx) => { this.begin(); cx.notify(); });
    }
    const page = s.mode === "page";
    const row = h_flex().id(`cp-bar-${pane}`).flex_1().min_w(0).gap(2).items_center().text_size(12);
    row
      .child(this.button(t, `cp-back-${pane}`, "back", "Back  ·  Alt+←", "back", page && s.back))
      .child(this.button(t, `cp-fwd-${pane}`, "forward", "Forward  ·  Alt+→", "forward", page && s.fwd))
      .child(s.loading
        ? this.button(t, `cp-stop-${pane}`, "stop", "Stop loading", "stop", page)
        : this.button(t, `cp-reload-${pane}`, "reload", "Reload  ·  Ctrl+R", "reload", page))
      .child(div().flex_none().w(4));
    if (s.dialog) {
      row.child(this.says(t, `cp-says-${pane}`, `${s.dialog.type}: ${s.dialog.message}`, t.foreground, [
        this.answer(t, `cp-ok-${pane}`, "OK", "dialog-ok", true),
        ...(s.dialog.type === "alert" ? [] : [this.answer(t, `cp-cancel-${pane}`, "Cancel", "dialog-cancel")]),
      ]));
    } else if (s.resend) {
      row.child(this.says(t, `cp-says-${pane}`, "This page answers a form you sent: a reload sends the form again.", t.foreground, [
        this.answer(t, `cp-resend-${pane}`, "Send it again", "resend-yes", true),
        this.answer(t, `cp-keep-${pane}`, "Leave it", "resend-no"),
      ]));
    } else if (s.hidden) {
      row.child(this.says(t, `cp-says-${pane}`, "Chrome is not drawing this tab: it is behind another one.", t.muted, [
        this.answer(t, `cp-front-${pane}`, "Bring it forward", "front", true),
      ]));
    } else if (s.notice) {
      row.child(this.says(t, `cp-says-${pane}`, s.notice, t.muted));
    } else {
      row.child(this.field(t, pane, s));
    }
    const tabs = s.tabs > 0 ? String(s.tabs) : "";
    row.child(h_flex()
      .id(`cp-tabs-${pane}`)
      .flex_none()
      .h(22)
      .ml(4)
      .px(5)
      .gap(4)
      .items_center()
      .rounded(5)
      .text_color(s.mode === "tabs" ? t.foreground : t.muted)
      .when(s.mode === "tabs", (el) => el.bg(t.selected))
      .hover((st) => st.bg(t.hover).text_color(t.foreground))
      .tooltip(`Chrome’s tabs${tabs ? ` (${tabs})` : ""}  ·  Ctrl+T`)
      .on_click(() => { this.send("tabs"); })
      .child(svg(this.icon("tabs")).size(14).flex_none())
      .when(Boolean(tabs), (el) => el.child(div().flex_none().text_size(11).child(tabs))));
    return row;
  }
}
