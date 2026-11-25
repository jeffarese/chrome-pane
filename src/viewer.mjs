// The viewer: one Chrome tab drawn in this terminal, with the mouse and keyboard sent to it.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { actAt, barParts, editKey, editOf, looks, paint } from './bar.mjs';
import { connect } from './cdp.mjs';
import { hostOf } from './hosts.mjs';
import { InputParser } from './input.mjs';
import { keyCalls } from './keys.mjs';
import { drawnBy, notesDir, readAsk, readNote, registerPane, setDrawnBy, takeActs, unregisterPane, writeAsk, writeBar } from './panes.mjs';
import { changedCells, decodePng, encodePng } from './png.mjs';
import { fit, normalizeUrl, oneLine, place, pngSize, toPage } from './util.mjs';

const ST = '\x1b\\';
// The ids of the questions asked of the screens, above every picture's.
const PROBE = 4100000;
// A picture of more characters than this is not sent whole to a screen on another computer:
// Herdr drops what it holds for a screen that is behind once that passes four megabytes or so.
const BIG = 3000000;
const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1016l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l';
const BUTTONS = ['left', 'middle', 'right'];
// Asks the terminal its text and background colours: the bar is drawn in shades of them.
const COLORS = `\x1b]10;?${ST}\x1b]11;?${ST}`;
// This program, for the controls a multiplexer draws: they run it to say what was clicked.
const MAIN = fileURLToPath(new URL('./chrome-pane.mjs', import.meta.url));
// Whether what has the keyboard in the page takes text. A frame of another site cannot be looked
// into: it may well be a field.
const TYPING = `(() => {
  let e = document.activeElement;
  for (let i = 0; e && i < 20; i++) {
    if (e.shadowRoot && e.shadowRoot.activeElement) { e = e.shadowRoot.activeElement; continue; }
    if (e.tagName !== 'IFRAME' && e.tagName !== 'FRAME') break;
    let inner = null;
    try { inner = e.contentDocument; } catch {}
    if (!inner) return true;
    e = inner.activeElement;
  }
  if (!e) return false;
  if (e.isContentEditable || e.tagName === 'TEXTAREA') return true;
  return e.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|file|image|range|color|hidden)$/i.test(e.type);
})()`;
const MASK = { left: 1, right: 2, middle: 4 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isPage = (t) => t.type === 'page' && !/^(devtools|chrome-extension|chrome-untrusted):/.test(t.url);

export class Viewer {
  constructor(opts = {}) {
    this.opts = opts;
    this.out = opts.out ?? process.stdout;
    this.inp = opts.inp ?? process.stdin;
    this.parser = new InputParser();
    this.term = { cols: this.out.columns || 80, rows: this.out.rows || 24, cellW: 8, cellH: 17 };
    // The rows the bar takes: none while a page is shown under controls the multiplexer draws.
    Object.defineProperty(this.term, 'bar', { enumerable: true, get: () => (this.hosted && this.mode === 'page' && this.tab ? 0 : 1) });
    this.pixelMouse = false;
    this.mode = 'message';       // message | page | tabs
    this.message = 'Connecting to Chrome…';
    this.edit = null;            // the address being typed ({ text, cur, all }), or null
    this.parts = [];             // the bar as drawn: its pieces, and what a click on each does
    this.hot = null;             // the button of the bar under the mouse
    this.colors = { fg: null, bg: null }; // the terminal's own, once it has told them
    this.look = looks();         // how the bar's pieces are painted
    this.loading = false;        // the page is on its way
    this.hist = { back: false, fwd: false }; // whether the tab has a page to go back or forward to
    this.pageIds = new Set();    // Chrome's tabs, to count them
    this.host = null;            // the multiplexer this runs in, if any
    this.hosted = false;         // the multiplexer draws the controls: no bar of this viewer's own
    this.claimed = 0;            // when it last said so itself (its header repeats it while it is there)
    this.focusN = 0;             // counts the times its address field was asked for (Ctrl+L)
    this.pickN = 0;              // and the times the list of tabs was (Ctrl+T), where the multiplexer shows its own
    this.hostTabs = false;       // the multiplexer has a list of tabs of its own to show
    this.said = '';              // what it was last told the bar says
    this.tab = null;             // { targetId, sid, title, url }
    this.where = {};             // the multiplexer's terminal this runs in, and what it says of its tab, if any
    this.agent = null;           // what an agent is doing to the tab right now, for the bar
    this.geom = null;
    // auto: half the pixels while the page moves, the sharp picture once it rests.
    // sharp: every frame at full size. fast: never the sharp one.
    this.quality = ['sharp', 'fast'].includes(opts.quality) ? opts.quality : 'auto';
    this.nextImage = 0;          // the last image id given to the terminal
    this.shown = 0;              // the image on screen
    this.cache = new Map();      // a frame's hash -> the image of it the terminal still holds
    this.res = 'full';           // the size Chrome is asked for frames at: full, or half while the page moves
    this.resAt = 0;              // when that was last changed
    this.flat = false;           // Chrome's full-size frames have no more pixels than the half-size ones
    this.gen = 0;                // counts the pictures Chrome sent
    this.lastHash = null;
    this.runAt = 0;              // when the frames coming one after another began
    this.wholeInRun = 0;         // how many of those were sent whole
    this.raw = null;             // the pixels of the frame on screen, to send only what changes
    this.tiles = [];             // the small pictures laid over the big one since it was sent
    this.z = 0;
    this.nextAt = 0;             // no picture before then: the link has what was sent to carry
    this.probe = 0;              // the last question asked of the screens showing this pane
    this.asked = new Map();      // question -> how many screens have answered it
    this.viewers = 0;            // how many screens answer: the next picture waits for all of them
    this.settling = null;        // the question the next picture is waiting on
    this.unsettled = 0;          // characters of pictures written since the last question
    this.speed = 0;              // characters a millisecond the slowest screen took its last big picture at
    this.heavy = false;          // full-size pictures of this page are more than a far screen can be sent
    this.shownAs = '';           // the cells the picture on screen was placed in, to place it again
    this.checkedAt = 0;
    this.lostAt = 0;
    this.lostWait = 0;
    this.carefulUntil = 0;       // until then, pictures go by the clock: a screen stopped answering
    this.prevFrameAt = 0;
    this.held = 0;
    this.lastClick = { t: 0, x: 0, y: 0, button: '', count: 0 };
    this.frame = null;
    this.drawing = false;
    this.lastDraw = 0;
    this.minFrameMs = 1000 / (opts.fps || 20);
    // Characters a millisecond the terminal is given, at most: what a link to another computer
    // carries without falling behind (3 MB a second unless told otherwise).
    this.rate = (opts.rate > 0 ? opts.rate : 3) * 1000;
    this.tiling = opts.parts !== false;
    this.tabs = [];
    this.sel = 0;
    this.closing = null;         // the tab that x was pressed on in the list: closed if x is pressed again
    this.resend = false;         // Ctrl+R was pressed on the answer to a sent form: sent again if pressed again
    this.notice = null;          // a line shown in the bar for a moment
    this.backTo = null;          // the tab to return to when the one shown, which its page opened, closes
    this.startedAt = Date.now();
    this.dialog = null;
    this.hidden = false;         // Chrome isn't drawing the tab (it's behind another one, or its window is covered)
    this.mayFront = false;       // one automatic bring-to-front is owed: set when a tab is opened here
    // CHROME_PANE_DEBUG=<file>: what came in from the terminal and from Chrome, one line each.
    // CHROME_PANE_DEBUG logs everything, keys and addresses included. CHROME_PANE_TRACE logs
    // only what is drawn and when: safe to leave on in a pane someone types passwords in.
    const log = process.env.CHROME_PANE_DEBUG || process.env.CHROME_PANE_TRACE;
    this.quiet = !process.env.CHROME_PANE_DEBUG;
    this.debug = null;
    if (log) {
      // The log can hold what was typed: a file of the person's alone, and never through a link
      // someone else left at that path.
      const fd = fs.openSync(log, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.fchmodSync(fd, 0o600); } catch {}
      this.debug = (...a) => fs.writeSync(fd, `${Date.now() % 10000000} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);
    }
  }

  w(s) { return this.out.write(s); }
  flushed() { return new Promise((r) => this.out.write('', r)); }
  get scale() { return this.opts.scale || (this.term.cellH >= 26 ? 2 : 1); }
  /** The share of the pane's pixels (per side) that moving frames are sent at. */
  get motion() { return this.quality === 'sharp' ? 1 : this.scale < 2 ? (this.heavy ? 0.5 : 1) : 1 / this.scale; }
  /** Whether the size of the frames follows the page: half while it moves, full once it rests. */
  get adaptive() { return this.motion < 1 && this.quality === 'auto' && !this.flat && !this.heavy; }
  /** A screen on another computer: it takes pictures slower than any screen on this one would. */
  get far() { return this.viewers > 0 && this.speed > 0 && this.speed < 8000; }
  /** The pane's size as one value: its cells and their pixels. */
  sizeKey() { return `${this.term.cols}x${this.term.rows} ${this.term.cellW}x${this.term.cellH} ${this.term.bar}`; }

  area() {
    const cols = this.term.cols, rows = Math.max(1, this.term.rows - this.term.bar);
    return { cols, rows, pxW: cols * this.term.cellW, pxH: rows * this.term.cellH };
  }

  // ------------------------------------------------------------------ start and stop

  async run() {
    if (!this.inp.isTTY || !this.out.isTTY) throw new Error('the viewer needs a terminal');
    this.inp.setRawMode(true);
    this.inp.resume();
    // Herdr lists a program that reports a state as an agent; the page's title is the row's.
    this.w(`\x1b[?1049h\x1b[?25l\x1b[2J${MOUSE_ON}\x1b[?1016h\x1b[?2004h\x1b]7501;state=idle:app=chrome${ST}\x1b]2;Chrome${ST}`);
    this.inp.on('data', (d) => this.onInput(this.parser.feed(d)));
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => this.quit());
    // The terminal can also go without a signal (the program that held it died): leave then too,
    // or this would stay attached to the tab, holding it at the pane's size.
    for (const stream of [this.inp, this.out]) stream.on('error', () => this.quit());
    for (const ev of ['end', 'close']) this.inp.on(ev, () => this.quit());
    process.on('exit', () => { unregisterPane(); this.restore(); });
    // An agent's command finds the tab to act on by the pane of its own tab of Herdr, Rex or Tern.
    try { this.host = hostOf(); } catch {}
    try { this.where = this.host?.where(process.env) ?? {}; } catch {}
    // The terminal it would be told about is another program's (this runs in a terminal inside it).
    try { if (this.host?.publish && this.host.mine && !this.host.mine(process.env)) this.host = { ...this.host, publish: null }; } catch {}
    // Where the multiplexer drew the controls last time, it is about to again: no bar meanwhile,
    // or the page would be laid out twice. Nothing claims the pane (its tab is not on screen,
    // the header is gone): the bar comes back.
    if (this.host?.publish && !this.opts.bar && drawnBy(this.host.id)) {
      this.hosted = true;
      setTimeout(() => { if (!this.claimed) this.setNative(false); }, 4000).unref();
    }
    // A header that went without a word (the app was killed, its mod replaced) stops saying so.
    setInterval(() => { if (this.hosted && this.claimed && Date.now() - this.claimed > 80000) this.setNative(false); }, 10000).unref();
    // Known from the start, before it shows a tab: an agent asking for a page then asks this
    // pane, and does not open a second one beside it.
    this.announce();
    try {
      fs.mkdirSync(notesDir(), { recursive: true, mode: 0o700 });
      fs.watch(notesDir(), () => this.readAgent()).unref?.();
    } catch {}
    this.out.on('resize', () => this.onResize());
    await this.measure();
    this.draw();
    try {
      this.cdp = await connect(this.opts);
    } catch (e) { return this.fail(e.message); }
    this.cdp.on('bridge', (state) => { if (state === 'waiting') this.say('Waiting for Chrome: accept its “Allow remote debugging?” prompt.'); });
    this.cdp.on('close', (why) => this.fail(why || 'The connection to Chrome ended.'));
    this.cdp.on('event', (method, params, sid) => this.onEvent(method, params, sid));
    if (this.cdp.state === 'waiting') this.say('Waiting for Chrome: accept its “Allow remote debugging?” prompt.');
    try { await this.cdp.ready(); } catch (e) { return this.fail(e.message); }
    await this.cdp.send('Target.setDiscoverTargets', { discover: true });
    // The tabs Chrome already told this connection about are not announced again: counted now.
    this.pages().then(() => this.drawBar()).catch(() => {});
    setInterval(() => this.refreshInfo(), 2000).unref();
    setInterval(() => this.check(), 3000).unref();
    // A multiplexer makes a cell size up for a pane no window shows, and need not say when a
    // window then gives it a real one (the columns and rows may stay the same): asked again.
    // And its colours, which a change of theme changes.
    setInterval(() => this.w(`\x1b[16t${COLORS}`), 3000).unref();
    await this.begin();
  }

  /** Asks the terminal for its cell size and whether it reports the mouse in pixels. */
  measure() {
    return new Promise((resolve) => {
      this.measured = resolve;
      this.w(`\x1b[16t\x1b[?1016$p${COLORS}${this.question()}\x1b[c`);
      setTimeout(resolve, 700);
    }).then(() => { this.measured = null; if (!this.pixelMouse) this.w('\x1b[?1016l'); });
  }

  async begin() {
    const o = this.opts;
    try {
      if (o.url) {
        const { targetId } = await this.cdp.send('Target.createTarget', { url: normalizeUrl(o.url) ?? 'about:blank', background: true });
        return await this.attach(targetId);
      }
      const pages = await this.pages();
      if (o.tab) {
        const want = String(o.tab).toLowerCase();
        const hit = pages.find((t) => t.targetId === o.tab) ?? pages.find((t) => `${t.title} ${t.url}`.toLowerCase().includes(want));
        if (hit) return await this.attach(hit.targetId);
      }
      await this.showTabs();
    } catch (e) { this.fail(e.message); }
  }

  restore() {
    if (this.restored) return;
    this.restored = true;
    try {
      this.out.write(`${this.forget()}${MOUSE_OFF}\x1b[?2004l\x1b[?25h\x1b[?1049l`);
      if (this.inp.isTTY) this.inp.setRawMode(false);
    } catch {}
  }

  async quit(code = 0) {
    if (this.quitting) return;
    this.quitting = true;
    // Detaching gives the tab its own size back before we go.
    if (this.tab?.sid && this.cdp && !this.cdp.closed) await Promise.race([this.cdp.send('Target.detachFromTarget', { sessionId: this.tab.sid }).catch(() => {}), sleep(500)]);
    await this.unpublish();
    this.restore();
    await Promise.race([this.flushed(), sleep(300)]);
    process.exit(code);
  }

  async fail(text) {
    if (this.quitting) return;
    this.quitting = true;
    await this.unpublish();
    this.restore();
    this.out.write(`chrome-pane: ${text}\n`);
    await Promise.race([this.flushed(), sleep(300)]);
    process.exit(1);
  }

  /** A line in the bar for a moment, over the page's own. */
  note(text) {
    clearTimeout(this.noticeTimer);
    this.notice = text;
    this.noticeTimer = setTimeout(() => { this.notice = null; if (this.mode === 'page') this.drawBar(); }, 2500);
    this.drawBar();
  }

  say(text) {
    if (this.mode === 'message' && this.message === text) return;
    this.mode = 'message'; this.message = text; this.draw();
  }

  // ------------------------------------------------------------------ the tab being shown

  async pages() {
    const pages = (await this.cdp.send('Target.getTargets')).targetInfos.filter(isPage);
    this.pageIds = new Set(pages.map((t) => t.targetId));
    return pages;
  }

  /** Shows that tab. `backTo`: the tab whose page opened it, to return to when it closes. */
  async attach(targetId, backTo = null) {
    await this.detach();
    this.backTo = backTo;
    const { sessionId: sid } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const { targetInfo } = await this.cdp.send('Target.getTargetInfo', { targetId });
    // zoom: Chrome's zoom of this page (80% is 0.8; Chrome keeps one per site). points: the size
    // this pane gave the page, in the window's points. view: what the page shows, in CSS pixels.
    // posted: the page is the answer to a form that was sent (null: not known yet).
    this.tab = { targetId, sid, title: targetInfo.title, url: targetInfo.url, zoom: 1, points: null, view: null, posted: null };
    this.shownAt = Date.now();
    this.announce();
    this.mode = 'page';
    this.edit = null;
    this.dialog = null;
    this.resend = false;
    this.loading = false;
    this.hist = { back: false, fwd: false };
    this.geom = null;
    this.hidden = false;
    this.mayFront = true;
    // What was written before (a message, the list of tabs) must not show through where no picture is yet.
    this.w(`${this.forget()}\x1b[0m\x1b[2J`);
    this.draw();
    await this.cdp.send('Page.enable', {}, sid);
    // Which request brings each page, to know the answer to a sent form (see reload). No body is kept.
    await this.cdp.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, sid).catch(() => {});
    // The page that is there came before this looked: Chrome's history says if a form led to it.
    this.refreshHistory(this.tab, true);
    // The tab may not be the one in front in Chrome: it still gets a caret and focus events.
    await this.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sid).catch(() => {});
    await this.cast();
  }

  /**
   * The tab shown is gone: closed, or Chrome let go of it (it says the second before the first
   * when a tab closes). One that a page of this pane had opened (a sign-in window, a link in a
   * new tab) and that is now closed gives the pane back to that page; otherwise, the list of tabs.
   */
  async lost(tab, why) {
    if (this.tab !== tab) return;
    const back = this.backTo;
    this.tab = null; this.backTo = null;
    this.announce();
    try {
      await sleep(150);
      const pages = await this.pages();
      const closed = !pages.some((t) => t.targetId === tab.targetId);
      if (closed) why = 'That tab was closed.';
      if (!this.tab && closed && back && pages.some((t) => t.targetId === back)) return await this.attach(back);
    } catch {}
    if (!this.tab) await this.showTabs(why).catch(() => {});
  }

  /**
   * Asks Chrome where the page is in its tab's history: whether there is one to go back to, or
   * forward. `first`: the page was there before this looked, so the history also says if it is
   * the answer to a form.
   */
  async refreshHistory(tab = this.tab, first = false) {
    if (!tab?.sid) return;
    try {
      const h = await this.cdp.send('Page.getNavigationHistory', {}, tab.sid);
      if (this.tab !== tab) return;
      if (first && tab.posted === null && h.entries[h.currentIndex]?.transitionType === 'form_submit') this.setPosted(true);
      const back = h.currentIndex > 0, fwd = h.currentIndex < h.entries.length - 1;
      if (back !== this.hist.back || fwd !== this.hist.fwd) { this.hist = { back, fwd }; this.drawBar(); }
    } catch {}
  }

  /** Reads the tab's title and address again: Chrome doesn't announce every change of them. */
  async refreshInfo() {
    const tab = this.tab;
    if (!tab || this.mode !== 'page') return;
    try {
      const { targetInfo: t } = await this.cdp.send('Target.getTargetInfo', { targetId: tab.targetId });
      if (this.tab === tab && (t.title !== tab.title || t.url !== tab.url)) { tab.title = t.title; tab.url = t.url; this.drawBar(); }
    } catch {}
    await this.refreshView(tab);
  }

  /**
   * Works out how many CSS pixels the page shows across and down: a mouse event goes to the page
   * in those. It is the size this pane gave the page, in points, divided by Chrome's zoom of the
   * page (without that a click on a page at 80% lands at 80% of the way across). The size a
   * frame says it has is no use here: it is in points for some frames and in pixels for others.
   */
  async refreshView(tab = this.tab) {
    if (!tab?.sid) return;
    let css = null;
    try {
      const m = await this.cdp.send('Page.getLayoutMetrics', {}, tab.sid);
      css = m.cssVisualViewport;
      const zoom = css?.zoom || (css?.clientWidth && m.visualViewport?.clientWidth ? m.visualViewport.clientWidth / css.clientWidth : 0);
      if (zoom > 0.1 && zoom < 10) tab.zoom = zoom;
    } catch {}
    // Mirroring Chrome's own size, the page has the size Chrome's window gives it.
    const view = tab.points ? { w: tab.points.w / tab.zoom, h: tab.points.h / tab.zoom }
      : css?.clientWidth ? { w: css.clientWidth, h: css.clientHeight } : tab.view;
    if (view && (view.w !== tab.view?.w || view.h !== tab.view?.h)) this.debug?.('view', Math.round(view.w), Math.round(view.h), 'zoom', tab.zoom);
    tab.view = view;
  }

  /** Tells agents which tab this pane shows (none while it shows the list of tabs), and the dialog its page stopped at. */
  announce() {
    // `at` is when this pane last took a tab: a dialog opening must not make it "the latest".
    try { registerPane(this.tab?.targetId ?? null, this.where, this.tab ? this.dialog : null, this.shownAt ?? this.startedAt, Boolean(this.tab?.posted)); } catch {}
    this.readAgent();
  }

  /** An agent's answer to the page's dialog, which it leaves for this viewer to give. */
  readAsk() {
    for (const a of takeActs()) { try { this.act(a.act, a.arg); } catch {} }
    const tab = this.tab;
    // Asked of this pane itself while it shows no tab: open that address.
    const mine = readAsk(`pane-${process.pid}`);
    if (mine) {
      writeAsk(`pane-${process.pid}`, null);
      const url = typeof mine.open === 'string' && Date.now() - mine.at < 15000 ? normalizeUrl(mine.open) : null;
      if (url && /^(https?:|about:blank$)/i.test(url) && !tab && this.cdp?.state === 'ready') {
        this.cdp.send('Target.createTarget', { url, background: true }).then((r) => this.attach(r.targetId)).catch((e) => this.say(e.message));
      }
    }
    if (!tab) return;
    const ask = readAsk(tab.targetId);
    if (!ask) return;
    writeAsk(tab.targetId, null);
    if (!ask.dialog || !this.dialog || Date.now() - ask.at > 10000) return;
    const text = typeof ask.dialog.text === 'string' ? { promptText: ask.dialog.text } : {};
    this.cdp.send('Page.handleJavaScriptDialog', { accept: Boolean(ask.dialog.accept), ...text }, tab.sid).catch(() => {});
  }

  /** Shows in the bar, and to Herdr, that an agent is acting on this tab: for 5 s after its last call. */
  readAgent() {
    this.readAsk();
    clearTimeout(this.agentTimer);
    const note = this.tab ? readNote(this.tab.targetId) : null;
    const left = note ? 5000 - (Date.now() - note.at) : 0;
    const now = left > 0 ? oneLine(note.text) : null;
    if (left > 0) this.agentTimer = setTimeout(() => this.readAgent(), left + 20);
    if (now === this.agent) return;
    this.agent = now;
    // Only the bar says so. Herdr is never told the pane is working: when a program's turn ends,
    // Herdr reads a full-screen one by turning the mouse wheel in it and then sends every screen
    // the pane's text again, which scrolls the page and takes its picture away.
    if (this.mode === 'page') this.drawBar();
  }

  async detach() {
    const sid = this.tab?.sid;
    this.tab = null;
    this.geom = null;
    this.announce();
    if (sid) await this.cdp.send('Target.detachFromTarget', { sessionId: sid }).catch(() => {});
  }

  /** Sizes the page to this pane (unless mirroring Chrome's own size) and starts the frames. */
  async cast() {
    const sid = this.tab?.sid;
    if (!sid) return;
    const a = this.area();
    this.castFor = this.sizeKey();
    try {
      if (!this.opts.mirror) {
        // Never more pixels than the pane has: a frame that fits is shown pixel for pixel,
        // while one a pixel too big would be shrunk, all of it, and blurred.
        const points = { w: Math.max(160, Math.floor(a.pxW / this.scale)), h: Math.max(120, Math.floor(a.pxH / this.scale)) };
        await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: points.w, height: points.h, deviceScaleFactor: this.scale, mobile: false }, sid);
        if (this.tab?.sid === sid) this.tab.points = points;
      }
      await this.refreshView();
      clearTimeout(this.restTimer);
      this.debug?.('cast', a.pxW, a.pxH, this.term.cols, this.term.rows);
      this.w(this.forget(true));
      this.lastHash = null;
      this.prevFrameAt = 0;
      this.flat = false;
      this.heavy = false;
      // A page just opened or resized is shown sharp first; frames shrink once it moves.
      await this.frames(this.motion < 1 && this.quality === 'fast' ? 'half' : 'full', sid);
    } catch (e) { if (this.tab?.sid === sid) this.say(`Chrome refused: ${e.message}`); return; }
    // No frame after a moment: Chrome draws only the tab in front of a window it can see.
    const asked = (this.castAt = Date.now());
    setTimeout(async () => {
      if (this.tab?.sid !== sid || this.castAt !== asked || this.lastFrameAt >= asked) return;
      const r = await this.cdp.send('Runtime.evaluate', { expression: 'document.visibilityState' }, sid).catch(() => null);
      if (r?.result?.value === 'hidden' && this.tab?.sid === sid) this.setHidden(true);
    }, 1200);
  }

  /** (Re)starts Chrome's frames of the tab at the pane's full size, or at the share moving frames use. */
  async frames(res, sid = this.tab?.sid) {
    const a = this.area(), m = res === 'half' ? this.motion : 1;
    this.res = res;
    this.resAt = Date.now();
    this.debug?.('frames', res);
    await this.cdp.send('Page.stopScreencast', {}, sid).catch(() => {});
    await this.cdp.send('Page.startScreencast', { format: 'png', maxWidth: Math.round(a.pxW * m), maxHeight: Math.round(a.pxH * m), everyNthFrame: 1 }, sid);
  }

  /**
   * Changes the size of the frames while the page is shown. Chrome sends a frame at once at the
   * new size, so going back to full is what shows the sharp picture when the page comes to rest.
   * (Asking Chrome for a screenshot would do too, but while it takes one of a page whose size is
   * set here, it changes how the page takes mouse events, and clicks made then are lost.)
   */
  setRes(res) {
    const sid = this.tab?.sid;
    if (!sid || this.res === res || this.mode !== 'page') return;
    this.frames(res, sid).catch(() => {});
  }

  /** Chrome stopped (or started) drawing the tab. The first time after opening it here, it is brought forward. */
  setHidden(hidden) {
    if (!this.tab) return;
    this.hidden = hidden;
    if (hidden && this.mayFront && this.opts.front !== false) this.front();
    else if (this.mode === 'page') this.drawBar();
  }

  /** Makes the tab the one in front in Chrome, which is what makes Chrome draw it. */
  front() {
    const sid = this.tab?.sid;
    if (!sid || Date.now() - (this.frontAt || 0) < 1000) return;
    this.frontAt = Date.now();
    this.mayFront = false;
    this.cdp.send('Page.bringToFront', {}, sid).catch(() => {});
  }

  onEvent(method, p, sid) {
    const tab = this.tab;
    if (method.startsWith('Network.')) {
      // The request for the page itself: its method says whether a reload would send a form again.
      if (method === 'Network.requestWillBeSent' && tab && sid === tab.sid && p.type === 'Document' && p.frameId === tab.targetId) this.setPosted(p.request?.method === 'POST');
      return;
    }
    if (method !== 'Page.screencastFrame') this.debug?.('chrome', method, p.targetInfo && !this.quiet ? { title: p.targetInfo.title, url: p.targetInfo.url.slice(0, 60) } : method === 'Page.screencastVisibilityChanged' ? p.visible : '');
    if (method === 'Page.screencastFrame') {
      if (!tab || sid !== tab.sid) return;
      const now = (this.lastFrameAt = Date.now());
      if (this.hidden) { this.hidden = false; this.drawBar(); }
      p.hash = createHash('md5').update(p.data).digest('base64');
      // The same picture again: nothing to do.
      if (p.hash === this.lastHash) return void this.cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sid).catch(() => {});
      // A frame on its own is a small change (a caret, a hover); several in a row are motion.
      p.isolated = now - this.prevFrameAt > 250;
      if (p.isolated) { this.runAt = now; this.wholeInRun = 0; }
      p.gen = ++this.gen;
      this.prevFrameAt = now;
      this.lastHash = p.hash;
      this.frame = p;
      if (this.adaptive) {
        // Frames in a row that had to be sent whole are motion (a scroll, a film): ask for small
        // ones. A row lighting up under the mouse or a letter typed is not: only the cells that
        // changed are sent, sharp. (Nor right after a change of size, which brings frames by
        // itself.) Quiet for a moment: back to full size.
        clearTimeout(this.restTimer);
        if (!p.isolated && this.res === 'full' && this.wholeInRun >= 2 && now - this.resAt > 400) this.setRes('half');
        if (this.res === 'half') this.restTimer = setTimeout(() => this.setRes('full'), 350);
      }
      if (!this.drawing) this.drawFrames();
    } else if (method === 'Target.targetInfoChanged') {
      const t = p.targetInfo;
      this.countPage(t.targetId, isPage(t));
      if (tab && t.targetId === tab.targetId) { tab.title = t.title; tab.url = t.url; this.drawBar(); }
      if (this.mode === 'tabs') this.refreshTabs();
    } else if (method === 'Target.targetCreated') {
      const t = p.targetInfo;
      this.countPage(t.targetId, isPage(t));
      // A link that opens a new tab: follow it.
      if (tab && this.mode === 'page' && isPage(t) && t.openerId === tab.targetId) this.attach(t.targetId, tab.targetId).catch(() => {});
      else if (this.mode === 'tabs') this.refreshTabs();
    } else if (method === 'Target.targetDestroyed') {
      this.countPage(p.targetId, false);
      if (tab && p.targetId === tab.targetId) this.lost(tab, 'That tab was closed.');
      else if (this.mode === 'tabs') this.refreshTabs();
    } else if (method === 'Target.detachedFromTarget') {
      if (tab && p.sessionId === tab.sid) this.lost(tab, 'Chrome detached that tab.');
    } else if ((method === 'Page.frameNavigated' || method === 'Page.loadEventFired' || method === 'Page.navigatedWithinDocument') && tab && sid === tab.sid) {
      // Another page may be light enough to be sent sharp.
      if (method === 'Page.frameNavigated' && !p.frame?.parentId && this.heavy) { this.heavy = false; this.setRes(this.quality === 'fast' && this.motion < 1 ? 'half' : 'full'); }
      if (method === 'Page.loadEventFired') this.setLoading(false);
      this.refreshInfo();
      this.refreshHistory(tab);
    } else if ((method === 'Page.frameStartedLoading' || method === 'Page.frameStoppedLoading') && tab && sid === tab.sid) {
      // The page's own frame, not one inside it: its reload button is a stop button meanwhile.
      if (p.frameId === tab.targetId) this.setLoading(method === 'Page.frameStartedLoading');
    } else if (method === 'Page.screencastVisibilityChanged' && tab && sid === tab.sid) {
      this.setHidden(!p.visible);
    } else if (method === 'Page.javascriptDialogOpening' && tab && sid === tab.sid) {
      this.dialog = { type: p.type, message: p.message };
      this.announce();
      this.drawBar();
    } else if (method === 'Page.javascriptDialogClosed' && tab && sid === tab.sid) {
      this.dialog = null;
      this.announce();
      this.drawBar();
    }
  }

  setLoading(loading) {
    if (this.loading === loading) return;
    this.loading = loading;
    if (this.mode === 'page') this.drawBar();
  }

  /** Keeps the count of Chrome's tabs, which the bar shows. */
  countPage(targetId, page) {
    if (page === this.pageIds.has(targetId)) return;
    if (page) this.pageIds.add(targetId); else this.pageIds.delete(targetId);
    if (this.mode === 'page') this.drawBar();
  }

  // ------------------------------------------------------------------ drawing

  draw() {
    if (this.mode === 'page') return this.drawBar();
    clearTimeout(this.restTimer);
    // Between these two marks a terminal that knows them shows nothing half-drawn.
    this.w(`\x1b[?2026h${this.forget()}\x1b[0m\x1b[2J`);
    this.geom = null;
    this.drawBar();
    if (this.mode === 'message') this.w(`\x1b[3;3H${fit(this.message, this.term.cols - 4)}`);
    else this.drawTabs();
    this.w('\x1b[?2026l');
  }

  /** What the bar says, whoever draws it: this viewer (bar.mjs) or the multiplexer's own controls. */
  barState() {
    const tab = this.mode === 'page' ? this.tab : null;
    const closing = this.mode === 'tabs' && this.closing ? this.tabs.find((x) => x.targetId === this.closing) : null;
    return {
      mode: this.mode === 'page' && !tab ? 'message' : this.mode,
      url: tab?.url ?? '', title: tab?.title ?? '', loading: Boolean(tab && this.loading), back: this.hist.back, fwd: this.hist.fwd, tabs: this.pageIds.size,
      agent: tab ? this.agent : null, dialog: this.dialog, resend: Boolean(tab && this.resend), hidden: Boolean(tab && this.hidden), notice: tab ? this.notice : null,
      closing: this.mode === 'tabs' && this.closing ? closing?.title || closing?.url || 'this tab' : null,
      edit: this.edit, hot: this.hot,
    };
  }

  drawBar() {
    const state = this.barState();
    this.parts = this.term.bar ? barParts(state, this.term.cols) : [];
    if (this.term.bar) this.w(`\x1b[1;1H${paint(this.parts, this.look, this.hot)}`);
    if (this.mode === 'page' && this.tab) this.w(`\x1b]2;${oneLine(this.tab.title || this.tab.url || 'Chrome').slice(0, 120)}${ST}`);
    this.publish(state);
  }

  /**
   * Says what the bar says to whoever does not look at this terminal: a file that `chrome-pane
   * bar` prints, and the multiplexer, for the controls it draws itself (Herdr's pane header).
   * Once per change; the multiplexer gets the latest when several come while it is being told.
   */
  publish(state = this.barState()) {
    if (this.quitting) return;
    const { edit, hot, closing, ...s } = state;
    // native: the multiplexer draws the controls. own: it is not to (--bar): this viewer keeps its bar.
    const text = JSON.stringify({ v: 1, pid: process.pid, cli: [process.execPath, MAIN], native: this.hosted, own: Boolean(this.opts.bar), focus: this.focusN, pick: this.pickN, tab: this.tab?.targetId ?? null, ...s,
      url: s.url.slice(0, 2000), title: oneLine(s.title).slice(0, 200), dialog: s.dialog && { type: s.dialog.type, message: oneLine(s.dialog.message ?? '').slice(0, 300) } });
    if (text === this.saying) return;
    this.saying = text;
    try { writeBar(text); } catch {}
    if (!this.host?.publish) return;
    if (this.telling || this.saying === this.said) return;
    this.telling = (async () => {
      let failed = 0;
      while (this.saying !== this.said && !this.quitting) {
        await sleep(30);
        const text = this.saying;
        // A multiplexer that cannot be told (its program is gone) is not asked for ever.
        if (await this.host.publish(text, process.env)) failed = 0; else if (++failed >= 3) { this.host = { ...this.host, publish: null }; break; }
        this.said = text;
      }
      this.telling = null;
    })();
  }

  /** Takes back what the multiplexer was told: its controls are for a pane that shows Chrome. */
  async unpublish() {
    const host = this.host;
    if (!host?.publish || !this.said) return;
    this.host = { ...host, publish: null };
    await Promise.race([Promise.resolve(this.telling).then(() => host.publish('', process.env)), sleep(600)]);
  }

  /**
   * The multiplexer draws the controls for this pane (or stopped): the page gets the bar's row
   * (or gives it back). Asked by its controls themselves, whenever one starts or goes.
   */
  setNative(on) {
    if (on) { this.claimed = Date.now(); if (this.host) setDrawnBy(this.host.id, true); }
    on = Boolean(on) && !this.opts.bar && Boolean(this.host?.publish);
    if (!on) this.hostTabs = false;
    if (on === this.hosted) return this.publish();
    const shown = this.term.bar;
    this.hosted = on;
    this.hot = null;
    if (on && this.mode === 'page') this.edit = null;
    if (this.term.bar === shown) return this.publish();
    // The page has one row more, or one less: everything is drawn again at its new size.
    this.w(`${this.forget()}\x1b[0m\x1b[2J`);
    this.geom = null;
    this.draw();
    this.cast();
  }

  /**
   * One action of the bar: a click on it, the key that stands for it, or what the multiplexer's
   * own controls ask (chrome-pane bar <terminal> <action> [value]).
   */
  act(name, arg = null) {
    const tab = this.tab, page = this.mode === 'page' && tab ? tab : null;
    const ready = this.cdp && this.cdp.state === 'ready';
    // "on tabs": the multiplexer also has a list of tabs of its own, to show in place of this one's.
    if (name === 'native') { this.hostTabs = arg === 'on tabs'; return this.setNative(arg === 'on' || arg === 'on tabs'); }
    if (!ready) return;
    if (name === 'back' || name === 'forward') { if (page) this.history(name === 'back' ? -1 : 1); }
    else if (name === 'reload') { if (page) this.reload(); }
    else if (name === 'stop') { if (page) this.cdp.send('Page.stopLoading', {}, page.sid).catch(() => {}); }
    else if (name === 'front') this.front();
    else if (name === 'address') {
      if (!page) return;
      // The multiplexer's own field takes the typing: it is told that it was asked for.
      if (this.hosted) { this.focusN++; return this.publish(); }
      this.edit = editOf(page.url); this.newTab = false; this.drawBar();
    } else if (name === 'go') {
      const url = typeof arg === 'string' ? normalizeUrl(arg) : null;
      if (page && url) { this.resend = false; this.cdp.send('Page.navigate', { url }, page.sid).catch(() => {}); }
    } else if (name === 'tabs') {
      if (this.mode === 'tabs') this.backToPage();
      // The multiplexer's own list: it is told that it was asked for.
      else if (page && this.hosted && this.hostTabs) { this.pickN++; this.publish(); }
      else this.showTabs().catch(() => {});
    } else if (name === 'show') {
      // One of Chrome's tabs, by its id (chrome-pane tabs --json): shown here in place of this one.
      if (typeof arg !== 'string' || !this.pageIds.has(arg)) return;
      if (arg === tab?.targetId) { if (this.mode === 'tabs') this.backToPage(); return; }
      this.attach(arg).catch((e) => this.showTabs(e.message).catch(() => {}));
    } else if (name === 'close-tab') {
      // Closed in the person's real Chrome, with whatever was unsaved in it: whoever asks has asked them.
      if (typeof arg === 'string' && this.pageIds.has(arg)) this.cdp.send('Target.closeTarget', { targetId: arg }).catch(() => {});
    } else if (name === 'new') {
      // A new tab, shown here: at that address, or empty with the address field ready to be typed in.
      const url = typeof arg === 'string' && arg.trim() ? normalizeUrl(arg) : 'about:blank';
      if (!url) return;
      this.cdp.send('Target.createTarget', { url, background: true }).then((r) => this.attach(r.targetId))
        .then(() => { if (url === 'about:blank') this.act('address'); }).catch((e) => this.say(e.message));
    }
    else if (name === 'page') { if (this.mode === 'tabs') this.backToPage(); }
    else if (name === 'newtab') { if (this.mode === 'tabs') { this.edit = editOf(''); this.newTab = true; this.drawBar(); } }
    else if (name === 'dialog-ok' || name === 'dialog-cancel') {
      if (page && this.dialog) this.cdp.send('Page.handleJavaScriptDialog', { accept: name === 'dialog-ok' }, page.sid).catch(() => {});
    } else if (name === 'resend-yes') { if (page && this.resend) this.reload(); }
    else if (name === 'resend-no') { if (this.resend) { this.resend = false; this.drawBar(); } }
    else if (name === 'close-yes' || name === 'close-no') {
      const id = this.closing;
      if (this.mode !== 'tabs' || !id) return;
      this.closing = null;
      this.drawBar();
      if (name === 'close-yes') this.cdp.send('Target.closeTarget', { targetId: id }).catch(() => {});
    } else if (name === 'edit-go' || name === 'edit-cancel') { if (this.edit) this.onEditKey({ type: 'key', name: name === 'edit-go' ? 'Enter' : 'Escape' }); }
  }

  /** From the list of tabs back to the page that was shown; with none, there is nothing to stay for. */
  backToPage() {
    if (!this.tab) return this.quit();
    this.mode = 'page';
    this.edit = null;
    this.w('\x1b[2J');
    this.draw();
    this.cast();
  }

  drawTabs() {
    const { cols, rows } = this.term;
    const room = Math.max(1, rows - 3);
    const top = Math.max(0, Math.min(this.sel - Math.floor(room / 2), this.tabs.length - room));
    let s = '';
    for (let i = 0; i < room; i++) {
      const t = this.tabs[top + i];
      const line = t ? `${t.targetId === this.tab?.targetId ? '●' : ' '} ${t.title || '(untitled)'} — ${t.url}` : '';
      s += `\x1b[${i + 3};1H${top + i === this.sel && t ? '\x1b[7m' : ''} ${fit(line, cols - 2)} \x1b[0m`;
    }
    if (!this.tabs.length) s += `\x1b[3;3H${fit(this.message || 'Chrome has no tabs. Press n for a new one.', cols - 4)}`;
    else if (this.message) s += `\x1b[2;3H${fit(this.message, cols - 4)}`;
    this.tabTop = top;
    this.w(s);
  }

  async drawFrames() {
    this.drawing = true;
    try {
      while (this.frame) {
        const p = this.frame, sid = this.tab?.sid;
        this.frame = null;
        if (!sid) break;
        if (this.mode === 'page') {
          const held = this.cache.get(p.hash);
          if (held && this.geom) {
            // The terminal already has exactly this picture: show it again, for a few bytes.
            this.debug?.('frame', 'held', p.gen);
            this.raw = null;
            this.shownAs = `,c=${this.geom.c},r=${this.geom.r}`;
            // q=1: a screen that no longer has it says so (onGfx), and the page is sent again.
            await this.write(`\x1b[${this.geom.row0 + 1};${this.geom.col0 + 1}H\x1b_Ga=p,i=${held},p=1,q=1,C=1${this.shownAs}${ST}${this.retire(held)}${this.dropTiles()}`);
            await this.settle();
          } else {
            const wait = Math.max(this.lastDraw + this.minFrameMs, this.nextAt) - Date.now();
            if (wait > 0) await sleep(wait);
            if (this.tab?.sid !== sid || this.mode !== 'page') continue;
            // A newer frame came while this one waited its turn: that one is the one to show.
            if (this.frame) { this.cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sid).catch(() => {}); continue; }
            const res = this.res;
            // More than Herdr keeps for a screen that is behind (BIG): on another computer it would
            // never be seen. The page then stays at the size moving frames have.
            if (res === 'full' && p.data.length > BIG && this.far && !this.heavy && this.quality !== 'sharp') {
              this.debug?.('heavy', `${Math.round(p.data.length / 1024)}KB`);
              this.heavy = true;
              this.setRes('half');
              this.cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sid).catch(() => {});
              continue;
            }
            this.lastDraw = Date.now();
            const id = await this.drawFrame(p, res);
            await this.settle();
            // Chrome's window is on a screen of one pixel a point: asked for full size, it has no
            // more to send than at half size, so there is nothing to switch between.
            if (res === 'full' && this.motion < 1 && this.drawnW && this.drawnW <= this.area().pxW * this.motion * 1.1) this.flat = true;
            // A full-size frame on its own is the page at rest, which tends to come back (a caret
            // blinks between two pictures): the terminal keeps the last two.
            if (id && !this.raw && res === 'full' && p.isolated && this.motion < 1) this.keep(p.hash, id);
          }
        }
        // A page that never rests is asked about between its frames.
        if (Date.now() - this.checkedAt > 2000) this.check();
        // Chrome sends the next frame only once this one is acknowledged: the pace follows the terminal.
        this.cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sid).catch(() => {});
      }
    } finally { this.drawing = false; }
  }

  /** A question every screen showing this pane answers once it has drawn all that was written before it. */
  question() {
    const id = PROBE + (this.probe = (this.probe % 1000) + 1);
    this.asked.set(id, 0);
    if (this.asked.size > 8) this.asked.delete(this.asked.keys().next().value);
    return `\x1b_Ga=q,i=${id},s=1,v=1,t=d,f=24;AAAA${ST}`;
  }

  /**
   * Waits until every screen showing this pane has drawn what was just written, so that no
   * screen is ever sent more than it has taken. Herdr keeps a few megabytes for a screen that
   * is behind (the app on another computer, over a slow link) and then drops them all, sending
   * that screen the pane's text again without its pictures: a page gone black under its bar.
   * A terminal that answers nothing is paced by the clock instead (sent()).
   */
  settle() {
    const bytes = this.unsettled;
    this.unsettled = 0;
    const ask = this.question(), id = PROBE + this.probe, at = Date.now();
    this.w(ask);
    if (!this.viewers) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (why) => {
        const late = why === 'late';
        clearTimeout(timer);
        this.settling = null;
        const ms = Date.now() - at;
        if (why === 'lost') {
          // The question went with the pictures: nobody will answer it.
        } else if (late) {
          // A screen went away, or is too far behind to answer in time: go on without it, but
          // for a while no faster than it was taking pictures, or it would never catch up.
          this.viewers = this.asked.get(id) ?? 0;
          this.carefulUntil = Date.now() + 20000;
          if (bytes > BIG && this.quality !== 'sharp' && !this.heavy) { this.heavy = true; this.setRes('half'); }
        } else if (bytes > 200000) this.speed = bytes / Math.max(1, ms);
        this.debug?.('settled', `${Math.round(bytes / 1024)}KB`, `${ms} ms`, why ?? '', `${this.viewers} screens`);
        resolve();
      };
      // As long as the slowest screen would take it and two megabytes it may still have to
      // draw (a link of 300 KB a second, when no picture has been timed yet), within reason.
      const timer = setTimeout(() => done('late'), Math.min(15000, Math.max(2000, (bytes + 2e6) / (this.speed || 300))));
      this.settling = { id, done };
    });
  }

  /** A screen's answer to a picture command: to a question, or that it does not have the picture it was told to show. */
  onGfx(ev) {
    if (this.asked.has(ev.id)) {
      const n = this.asked.get(ev.id) + 1;
      this.asked.set(ev.id, n);
      // One more screen than was counted on (it has just connected, or was behind): how fast it
      // takes pictures is not known yet.
      if (n > this.viewers) { this.viewers = n; this.speed = 0; this.carefulUntil = 0; }
      if (this.settling?.id === ev.id && n >= this.viewers) this.settling.done();
    } else if (!ev.ok && ev.id && ev.id === this.shown) this.repaint();
  }

  /**
   * Asks the screens to show the picture they have again, which changes nothing on one that has
   * it; one that does not answers so. Herdr sends a screen the pane's text without its pictures
   * when it connects, comes back, or fell too far behind.
   */
  check() {
    if (this.mode !== 'page' || !this.tab || !this.shown || !this.geom) return;
    const now = Date.now();
    if (now - this.lostAt < this.lostWait) return;
    this.checkedAt = now;
    this.debug?.('check', this.shown);
    this.w(`\x1b[${this.geom.row0 + 1};${this.geom.col0 + 1}H\x1b_Ga=p,i=${this.shown},p=1,q=1,C=1${this.shownAs}${ST}`);
  }

  /** A screen does not have the picture: the page is sent again, whole. Less and less often if it keeps happening. */
  repaint() {
    const now = Date.now();
    this.lostWait = now - this.lostAt < 30000 ? Math.min(60000, Math.max(3000, this.lostWait * 2)) : 0;
    this.lostAt = now;
    this.debug?.('repaint', this.shown);
    this.settling?.done('lost');
    // The screens that have the picture keep it until the new one is over it.
    this.w(this.forget(true));
    this.lastHash = null;
    if (this.tab?.sid && this.mode === 'page') this.frames(this.res).catch(() => {});
  }

  /** Remembers that the terminal holds image `id` for the frame with this hash; the oldest of three goes. */
  keep(hash, id) {
    this.cache.set(hash, id);
    while (this.cache.size > 2) {
      const [first, old] = this.cache.entries().next().value;
      this.cache.delete(first);
      if (old !== this.shown) this.w(`\x1b_Ga=d,d=I,i=${old},q=2${ST}`);
    }
  }

  write(s) { return new Promise((resolve) => this.out.write(s, resolve)); }

  /** Takes the picture that was on screen away, keeping its data if it may be shown again. */
  retire(next) {
    const old = this.shown;
    this.shown = next;
    if (!old || old === next) return '';
    const kept = [...this.cache.values()].includes(old);
    return `\x1b_Ga=d,d=${kept ? 'i' : 'I'},i=${old},q=2${ST}`;
  }

  /** Frees the pictures the terminal holds: all of them, or all but the one on screen. */
  forget(keepShown = false) {
    let s = this.dropTiles();
    this.raw = null;
    for (const id of this.cache.values()) if (!(keepShown && id === this.shown)) s += `\x1b_Ga=d,d=I,i=${id},q=2${ST}`;
    this.cache.clear();
    if (!keepShown) { s += `\x1b_Ga=d,d=A,q=2${ST}`; this.shown = 0; }
    return s;
  }

  /** Sends a PNG and shows it in the area under the bar. Resolves to its image id. */
  /**
   * Shows a frame: only the cells that differ from what is on screen when those are few, the
   * whole picture otherwise. Resolves to the id of the big picture on screen.
   */
  async drawFrame(p, kind) {
    const size = pngSize(p.data);
    if (!size) return 0;
    const g = place(size, this.term);
    // A picture shown pixel for pixel: a part of it then covers its cells exactly.
    const cw = this.term.cellW, ch = this.term.cellH;
    const raw = this.tiling && this.native(size) ? decodePng(p.data) : null;
    const was = this.raw;
    this.raw = raw;
    if (raw && was && this.shown && this.geom && this.geom.c === g.c && this.geom.r === g.r && this.tiles.length < 60) {
      const diff = changedCells(was, raw, cw, ch);
      if (diff && diff.share <= 0.4) {
        let s = '', bytes = 0;
        for (const r of diff.rects) {
          // The last column and row of cells may hold less picture than a cell has pixels.
          const x = r.c0 * cw, y = r.r0 * ch, w = Math.min((r.c1 - r.c0) * cw, raw.w - x), h = Math.min((r.r1 - r.r0) * ch, raw.h - y);
          const data = encodePng(raw, x, y, w, h).toString('base64');
          const id = (this.nextImage = (this.nextImage % 4000000) + 1);
          const cells = w === (r.c1 - r.c0) * cw && h === (r.r1 - r.r0) * ch ? `c=${r.c1 - r.c0},r=${r.r1 - r.r0},` : '';
          s += `\x1b[${g.row0 + r.r0 + 1};${g.col0 + r.c0 + 1}H${this.image(`a=T,f=100,i=${id},p=1,q=2,C=1,${cells}z=${++this.z}`, data)}`;
          // A part laid over an older part hides it for good: the terminal need not keep that one.
          this.tiles = this.tiles.filter((t) => {
            if (t.c0 < r.c0 || t.c1 > r.c1 || t.r0 < r.r0 || t.r1 > r.r1) return true;
            s += `\x1b_Ga=d,d=I,i=${t.id},q=2${ST}`;
            return false;
          });
          this.tiles.push({ id, ...r });
          bytes += data.length;
        }
        const t0 = Date.now();
        if (s) await this.write(s);
        this.sent(bytes);
        this.debug?.('frame', 'part', `${diff.rects.length} of ${Math.round(diff.share * 100)}%`, `${Math.round(bytes / 1024)}KB`, `written in ${Date.now() - t0} ms`, `${this.tiles.length} held`);
        return this.shown;
      }
    }
    this.wholeInRun++;
    return this.drawImage(p.data, p.metadata, kind);
  }

  /**
   * Is a frame of this size one picture pixel a pane pixel? It is when it has the size the
   * page was given, which is the pane's or a few pixels under it (less than a cell).
   */
  native(size) {
    const a = this.area(), pts = this.tab?.points;
    return Boolean(pts) && size.w === pts.w * this.scale && size.h === pts.h * this.scale && size.w <= a.pxW && size.h <= a.pxH && a.pxW - size.w < this.term.cellW && a.pxH - size.h < this.term.cellH;
  }

  /** A picture as the terminal takes it: in pieces of 4096 characters. */
  image(head, data) {
    let s = '';
    for (let i = 0; i < data.length; i += 4096) s += `\x1b_G${i === 0 ? `${head},` : ''}m=${i + 4096 < data.length ? 1 : 0};${data.slice(i, i + 4096)}${ST}`;
    return s;
  }

  /** So many characters went to the terminal: the next picture waits for the link to carry them. */
  sent(bytes) {
    this.unsettled += bytes;
    const now = Date.now(), careful = now < this.carefulUntil;
    this.nextAt = this.viewers && !careful ? 0 : now + bytes / (careful ? Math.min(this.rate, this.speed || 300) : this.rate);
  }

  /** Takes the parts laid over the big picture away. */
  dropTiles() {
    let s = '';
    for (const t of this.tiles) s += `\x1b_Ga=d,d=I,i=${t.id},q=2${ST}`;
    this.tiles = [];
    this.z = 0;
    return s;
  }

  async drawImage(data, meta, kind) {
    const size = pngSize(data);
    if (!size) return 0;
    const g = place(size, this.term);
    const id = (this.nextImage = (this.nextImage % 4000000) + 1);
    // Pixel for pixel when it can be: fitted to cells it is a pixel short of, it would be stretched.
    const exact = size.w === g.c * this.term.cellW && size.h === g.r * this.term.cellH;
    const cells = this.native(size) && !exact ? '' : `,c=${g.c},r=${g.r}`;
    const head = `a=T,f=100,i=${id},p=1,q=2,C=1${cells}`;
    let s = `\x1b[${g.row0 + 1};${g.col0 + 1}H`;
    for (let i = 0; i < data.length; i += 4096) {
      const more = i + 4096 < data.length ? 1 : 0;
      s += `\x1b_G${i === 0 ? `${head},` : ''}m=${more};${data.slice(i, i + 4096)}${ST}`;
    }
    // The new picture goes over the old one before the old one is dropped: no blank moment.
    s += this.retire(id) + this.dropTiles();
    this.geom = g;
    this.shownAs = cells;
    this.drawnW = size.w;
    const t0 = Date.now();
    await this.write(s);
    this.sent(data.length);
    this.debug?.('frame', kind, `${size.w}x${size.h}`, `${Math.round(data.length / 1024)}KB`, `at ${g.row0},${g.col0} ${g.c}x${g.r}`, `written in ${Date.now() - t0} ms`);
    return id;
  }

  onResize() {
    this.term.cols = this.out.columns || this.term.cols;
    this.term.rows = this.out.rows || this.term.rows;
    this.w('\x1b[16t');
    this.debug?.('resize', this.term.cols, this.term.rows);
    clearTimeout(this.resizeTimer);
    // A terminal says it changed size more often than it did: only a new size is a new page size.
    this.resizeTimer = setTimeout(() => { this.draw(); if (this.mode === 'page' && this.sizeKey() !== this.castFor) this.cast(); }, 120);
  }

  // ------------------------------------------------------------------ input

  onInput(events) {
    for (const ev of events) {
      try { this.onOne(ev); } catch {}
    }
    clearTimeout(this.escTimer);
    if (this.parser.pending) this.escTimer = setTimeout(() => this.onInput(this.parser.flush()), 40);
  }

  onOne(ev) {
    this.debug?.('in', this.quiet ? ev.type : ev, this.quiet ? '' : { mode: this.mode, pixelMouse: this.pixelMouse, geom: this.geom });
    if (ev.type === 'reply') return this.onReply(ev);
    if (ev.type === 'focus') return;
    if (ev.type === 'mouse') return this.onMouse(ev);
    if (ev.type === 'key' && ev.ctrl && ev.name === 'q') return this.quit();
    // Ctrl+C is copy to a page; with no page to give it to, it ends the program as in any terminal.
    if (ev.type === 'key' && ev.ctrl && ev.name === 'c') {
      if (this.mode !== 'page' || !this.tab || this.edit) return this.quit();
      this.note('Ctrl+C copies in the page · Ctrl+Q quits the viewer');
    }
    if (this.edit) return this.onEditKey(ev);
    if (this.mode === 'tabs') return this.onTabsKey(ev);
    if (this.mode !== 'page' || !this.tab) return ev.type === 'key' && (ev.name === 'q' || ev.name === 'Escape') ? this.quit() : undefined;
    const sid = this.tab.sid;
    if (this.hidden) this.front();
    if (ev.type === 'paste') {
      if (this.resend) { this.resend = false; this.drawBar(); }
      return void this.cdp.send('Input.insertText', { text: ev.text }, sid).catch(() => {});
    }
    if (this.dialog && (ev.name === 'Enter' || ev.name === 'Escape')) return this.act(ev.name === 'Enter' ? 'dialog-ok' : 'dialog-cancel');
    if (ev.ctrl && ev.name === 'r') return this.reload();
    // Any other key is the answer "no" to sending a form again, and nothing more.
    if (this.resend) { this.resend = false; return this.drawBar(); }
    if (ev.ctrl && ev.name === 'l') return this.act('address');
    if (ev.ctrl && ev.name === 't') return this.act('tabs');
    if (ev.alt && (ev.name === 'ArrowLeft' || ev.name === 'ArrowRight')) return void this.altArrow(ev);
    for (const c of keyCalls(ev)) this.cdp.send(c.method, c.params, sid).catch(() => {});
  }

  onReply(ev) {
    // A pane no window shows yet has no cell size to tell: Tern answers 1x1 until one does.
    if (ev.kind === 'cell' && ev.w >= 3 && ev.h >= 6 && (ev.w !== this.term.cellW || ev.h !== this.term.cellH)) {
      this.term.cellW = ev.w; this.term.cellH = ev.h;
      this.debug?.('cell', ev.w, ev.h);
      if (!this.measured && this.mode === 'page') this.cast();
    } else if (ev.kind === 'mode' && ev.mode === 1016) this.pixelMouse = ev.value === 1 || ev.value === 3;
    else if (ev.kind === 'color') {
      if (String(this.colors[ev.which]) === String(ev.rgb)) return;
      this.colors[ev.which] = ev.rgb;
      this.look = looks(this.colors.fg, this.colors.bg);
      if (!this.measured) this.drawBar();
    } else if (ev.kind === 'da') this.measured?.();
    else if (ev.kind === 'gfx') this.onGfx(ev);
  }

  setPosted(posted) {
    const tab = this.tab;
    if (!tab || tab.posted === posted) return;
    tab.posted = posted;
    if (this.resend) { this.resend = false; this.drawBar(); }
    this.announce();
  }

  /**
   * Reload, for Ctrl+R and the bar's ↻. Chrome reloads the answer to a sent form by sending the
   * form again: a payment, an order, a message. Its own reload asks first; asked through this
   * connection it does not, so this asks: the bar says so, and Ctrl+R again does it.
   */
  reload() {
    const tab = this.tab;
    if (!tab) return;
    if (tab.posted && !this.resend) { this.resend = true; return this.drawBar(); }
    this.resend = false;
    this.drawBar();
    this.cdp.send('Page.reload', {}, tab.sid).catch(() => {});
  }

  /**
   * Alt+← and Alt+→ go back and forward, except while the page is typed in: there they move by
   * a word, as Option and an arrow do on a Mac, and must not walk out of a half-filled form.
   */
  async altArrow(ev) {
    const tab = this.tab;
    let typing = false;
    try { typing = (await this.cdp.send('Runtime.evaluate', { expression: TYPING, returnByValue: true }, tab.sid)).result?.value === true; } catch {}
    if (this.tab !== tab) return;
    if (!typing) return this.history(ev.name === 'ArrowLeft' ? -1 : 1);
    for (const c of keyCalls(ev)) this.cdp.send(c.method, c.params, tab.sid).catch(() => {});
  }

  async history(step) {
    const sid = this.tab?.sid;
    if (!sid) return;
    try {
      const h = await this.cdp.send('Page.getNavigationHistory', {}, sid);
      const entry = h.entries[h.currentIndex + step];
      if (entry) await this.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, sid);
    } catch {}
  }

  onEditKey(ev) {
    if (ev.type === 'key' && ev.name === 'Escape') {
      this.edit = null;
      if (!this.tab) return void this.showTabs().catch(() => {});
    } else if (ev.type === 'key' && ev.name === 'Enter') {
      const url = normalizeUrl(this.edit.text);
      const fresh = this.newTab || !this.tab;
      this.edit = null;
      if (!url) return this.tab ? this.drawBar() : void this.showTabs().catch(() => {});
      if (fresh) return void this.cdp.send('Target.createTarget', { url, background: true }).then((r) => this.attach(r.targetId)).catch((e) => this.say(e.message));
      this.cdp.send('Page.navigate', { url }, this.tab.sid).catch(() => {});
    } else this.edit = editKey(this.edit, ev);
    this.drawBar();
  }

  // ------------------------------------------------------------------ mouse

  onMouse(ev) {
    const { cellW, cellH } = this.term;
    const px = this.pixelMouse ? ev.x : (ev.x - 0.5) * cellW;
    const py = this.pixelMouse ? ev.y : (ev.y - 0.5) * cellH;
    const wheel = (ev.b & 64) !== 0, motion = (ev.b & 32) !== 0, pressed = !ev.release && !wheel && !motion;
    if (this.mode !== 'tabs' && (this.mode !== 'page' || !this.tab)) return;
    if (this.mode === 'page' && this.hidden && pressed) this.front();
    if (this.term.bar && py < cellH && !this.held) {
      const act = wheel ? null : actAt(this.parts, Math.floor(px / cellW));
      this.setHot(act);
      if (pressed && (ev.b & 3) === 0) this.onBarClick(act);
      return;
    }
    this.setHot(null);
    if (this.mode === 'tabs') return this.onTabsMouse(ev, py, wheel, pressed);
    // A click on the page while an address is typed leaves the field, as it does in a browser.
    if (this.edit) { if (pressed) { this.edit = null; this.drawBar(); } return; }
    if (!this.geom || !this.tab.view) return;
    if (pressed && this.resend) { this.resend = false; this.drawBar(); }
    const sid = this.tab.sid;
    const at = toPage(px, py, { ...this.geom, cssW: this.tab.view.w, cssH: this.tab.view.h }, this.term);
    const modifiers = (ev.b & 4 ? 8 : 0) | (ev.b & 8 ? 1 : 0) | (ev.b & 16 ? 2 : 0);
    const send = (params) => { if (params.type !== 'mouseMoved') this.debug?.('mouse', params.type, at.x, at.y, at.inside); return this.cdp.send('Input.dispatchMouseEvent', { x: at.x, y: at.y, modifiers, ...params }, sid).catch((e) => this.debug?.('mouse refused', e.message)); };
    if (wheel) {
      if (!at.inside) return;
      const dir = ev.b & 3, step = 60;
      return void send({ type: 'mouseWheel', deltaX: dir === 2 ? -step : dir === 3 ? step : 0, deltaY: dir === 0 ? -step : dir === 1 ? step : 0 });
    }
    if (motion) {
      if (!at.inside && !this.held) return;
      // Many moves arrive between frames; the page only needs the last one.
      this.move = () => send({ type: 'mouseMoved', button: this.held & 1 ? 'left' : this.held & 2 ? 'right' : this.held & 4 ? 'middle' : 'none', buttons: this.held });
      if (!this.moveTimer) this.moveTimer = setTimeout(() => { this.moveTimer = null; this.move?.(); this.move = null; }, 16);
      return;
    }
    const button = BUTTONS[ev.b & 3];
    if (!button) return;
    if (this.move) { clearTimeout(this.moveTimer); this.moveTimer = null; this.move(); this.move = null; }
    if (ev.release) {
      if (!(this.held & MASK[button])) return;
      this.held &= ~MASK[button];
      return void send({ type: 'mouseReleased', button, buttons: this.held, clickCount: this.lastClick.count || 1 });
    }
    if (!at.inside) return;
    const now = Date.now(), last = this.lastClick;
    const again = last.button === button && now - last.t < 400 && Math.abs(last.x - at.x) < 6 && Math.abs(last.y - at.y) < 6;
    this.lastClick = { t: now, x: at.x, y: at.y, button, count: again ? (last.count % 3) + 1 : 1 };
    this.held |= MASK[button];
    send({ type: 'mousePressed', button, buttons: this.held, clickCount: this.lastClick.count });
  }

  /** The button of the bar the mouse is on is lit; a mouse that left the pane says nothing, so not for long. */
  setHot(act) {
    clearTimeout(this.hotTimer);
    if (act) this.hotTimer = setTimeout(() => this.setHot(null), 4000);
    if (act === this.hot) return;
    this.hot = act;
    this.drawBar();
  }

  onBarClick(act) {
    // The bar is asking a question (send the form again? close the tab?): a click beside its buttons says no.
    if (this.resend && act !== 'resend-yes') { this.resend = false; return this.drawBar(); }
    if (this.mode === 'tabs' && this.closing && act !== 'close-yes') { this.closing = null; return this.drawBar(); }
    if (act) this.act(act);
  }

  // ------------------------------------------------------------------ the list of tabs

  async showTabs(note = '') {
    this.mode = 'tabs';
    this.closing = null;
    this.edit = null;
    this.message = note;
    this.tabs = await this.pages();
    const at = this.tabs.findIndex((t) => t.targetId === this.tab?.targetId);
    this.sel = at >= 0 ? at : Math.min(this.sel, Math.max(0, this.tabs.length - 1));
    this.draw();
  }

  refreshTabs() {
    clearTimeout(this.tabsTimer);
    this.tabsTimer = setTimeout(async () => {
      if (this.mode !== 'tabs') return;
      const keep = this.tabs[this.sel]?.targetId;
      try { this.tabs = await this.pages(); } catch { return; }
      const at = this.tabs.findIndex((t) => t.targetId === keep);
      this.sel = at >= 0 ? at : Math.min(this.sel, Math.max(0, this.tabs.length - 1));
      if (this.mode === 'tabs') this.draw();
    }, 150);
  }

  async openSelected() {
    const t = this.tabs[this.sel];
    if (!t) return;
    if (t.targetId === this.tab?.targetId) { this.mode = 'page'; this.w('\x1b[2J'); this.draw(); return this.cast(); }
    try { await this.attach(t.targetId); } catch (e) { await this.showTabs(e.message); }
  }

  onTabsKey(ev) {
    if (ev.type !== 'key') return;
    const n = this.tabs.length;
    // Closing a tab is closing it in the person's real Chrome, with whatever was unsaved in it: x asks, x again does.
    if (this.closing) {
      const id = this.closing;
      this.closing = null;
      if (ev.name === 'x' && this.tabs[this.sel]?.targetId === id) { this.drawBar(); return void this.cdp.send('Target.closeTarget', { targetId: id }).catch(() => {}); }
      this.drawBar();
      if (ev.name === 'x' || ev.name === 'Escape') return;
    }
    if (ev.name === 'ArrowUp' || ev.name === 'k') this.sel = Math.max(0, this.sel - 1);
    else if (ev.name === 'ArrowDown' || ev.name === 'j') this.sel = Math.min(n - 1, this.sel + 1);
    else if (ev.name === 'Enter') return void this.openSelected();
    else if (ev.name === 'n') return this.act('newtab');
    else if (ev.name === 'x' && this.tabs[this.sel]) { this.closing = this.tabs[this.sel].targetId; return this.drawBar(); }
    else if (ev.name === 'q') return this.quit();
    else if (ev.name === 'Escape' || (ev.ctrl && ev.name === 't')) return this.backToPage();
    else return;
    this.sel = Math.max(0, this.sel);
    this.draw();
  }

  onTabsMouse(ev, py, wheel, pressed) {
    if (wheel) {
      const dir = ev.b & 3;
      this.sel = Math.max(0, Math.min(this.tabs.length - 1, this.sel + (dir === 0 ? -1 : dir === 1 ? 1 : 0)));
      return this.draw();
    }
    if (!pressed || (ev.b & 3) !== 0) return;
    this.closing = null;
    const row = Math.floor(py / this.term.cellH) - 2 + (this.tabTop || 0);
    if (row >= 0 && row < this.tabs.length) { this.sel = row; this.openSelected(); }
  }
}
