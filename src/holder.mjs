// The hidden pane: a tab of the person's Chrome that an agent drives with no pane to show it.
//
// An agent's commands find their tab through a pane, and a pane does more than draw: it is the
// connection that answers the page's dialogs (Chrome lets only one that was there when a dialog
// opened answer it), it follows a page into the tab it opens and back, and it knows when a page
// is the answer to a sent form. The holder does all of that and draws nothing. It registers as a
// pane (marked hidden), so every agent command works on it as on a pane.
//
// Its tab is a background tab of Chrome's window: never brought to the front, so the person's
// Chrome stays as they left it. Chrome slows such a tab down (its timers run once a second at
// most, its animation frames stop), which a page mostly gets through, more slowly.
//
// It goes when it is told to (`chrome-pane close`, which closes the tabs it opened), when a pane
// shows its tab (`chrome-pane show`: the person has it now), when the bridge goes, and after a
// while with no agent at work in it.
import fs from 'node:fs';
import { connect } from './cdp.mjs';
import { hostOf } from './hosts.mjs';
import { listPanes, notesDir, readAsk, readNote, registerPane, unregisterPane, writeAsk } from './panes.mjs';
import { normalizeUrl } from './util.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isPage = (t) => t.type === 'page' && !/^(devtools|chrome-extension|chrome-untrusted):/.test(t.url);
// No agent at work in the tab for this long, and the holder closes it (CHROME_PANE_HIDDEN_IDLE, in seconds).
const idleMs = () => (Number(process.env.CHROME_PANE_HIDDEN_IDLE) > 0 ? Number(process.env.CHROME_PANE_HIDDEN_IDLE) : 1800) * 1000;

export class Holder {
  constructor(opts = {}) {
    this.opts = opts;
    this.tab = null;             // { targetId, sid }
    this.owned = new Set();      // the tabs it opened, closed when it is told to close
    this.backTo = null;          // the tab whose page opened the one shown, to go back to when it closes
    this.dialog = null;
    this.posted = false;         // the page is the answer to a sent form: a reload would send it again
    this.state = 'connecting';   // connecting | waiting (for the person to allow Chrome's connection) | ready
    this.lost = null;            // why it has no tab, once it had one
    this.where = {};
    this.startedAt = this.usedAt = Date.now();
  }

  /** Tells agents which tab it holds, as a pane does: hidden, so they know there is nothing to look at. */
  announce() {
    const extra = { hidden: true, ...(this.state !== 'ready' ? { state: this.state } : {}), ...(!this.tab && this.lost ? { lost: this.lost } : {}) };
    try { registerPane(this.tab?.targetId ?? null, { ...this.where, ...extra }, this.tab ? this.dialog : null, this.shownAt ?? this.startedAt, this.posted); } catch {}
  }

  async run() {
    try { this.where = hostOf()?.where(process.env) ?? {}; } catch {}
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => this.quit({ closeTabs: true }));
    process.on('exit', () => unregisterPane());
    this.announce();
    try {
      fs.mkdirSync(notesDir(), { recursive: true, mode: 0o700 });
      fs.watch(notesDir(), () => this.readAsk()).unref?.();
    } catch {}
    try { this.cdp = await connect(this.opts); } catch { return this.quit(); }
    const waiting = () => { this.state = 'waiting'; this.announce(); };
    this.cdp.on('bridge', (state) => { if (state === 'waiting') waiting(); });
    if (this.cdp.state === 'waiting') waiting();
    // With the bridge gone, nothing can reach the tab: there is nothing left to hold.
    this.cdp.on('close', () => this.quit());
    this.cdp.on('event', (method, params, sid) => this.onEvent(method, params, sid).catch(() => {}));
    // From now, not from Chrome's approval: a holder left waiting on the prompt goes when unused
    // too, and does not open its address hours later.
    setInterval(() => this.check(), 1000).unref();
    try { await this.cdp.ready(); } catch { return this.quit(); }
    this.state = 'ready';
    this.announce();
    await this.cdp.send('Target.setDiscoverTargets', { discover: true });
    const url = normalizeUrl(this.opts.url ?? '') ?? 'about:blank';
    await this.open(url);
  }

  async open(url) {
    const { targetId } = await this.cdp.send('Target.createTarget', { url, background: true });
    this.owned.add(targetId);
    await this.attach(targetId);
  }

  async attach(targetId, backTo = null) {
    await this.detach();
    const { sessionId: sid } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    this.tab = { targetId, sid };
    this.backTo = backTo;
    this.dialog = null;
    this.posted = false;
    this.lost = null;
    this.shownAt = Date.now();
    this.announce();
    await this.cdp.send('Page.enable', {}, sid);
    // Which request brings each page, to know the answer to a sent form. No body is kept.
    await this.cdp.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, sid).catch(() => {});
    await this.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sid).catch(() => {});
    // A page that was there before (a tab it went back to): Chrome's history says if a form led to it.
    try {
      const h = await this.cdp.send('Page.getNavigationHistory', {}, sid);
      if (this.tab?.sid === sid && h.entries[h.currentIndex]?.transitionType === 'form_submit') { this.posted = true; this.announce(); }
    } catch {}
  }

  async detach() {
    const sid = this.tab?.sid;
    this.tab = null;
    if (sid) await this.cdp.send('Target.detachFromTarget', { sessionId: sid }).catch(() => {});
  }

  /** The tab is gone: back to the page that opened it, if it is still there; else no tab, and why. */
  async lost_(tab, why) {
    if (this.tab !== tab) return;
    const back = this.backTo;
    this.tab = null; this.backTo = null;
    await sleep(150);
    let closed = true;
    try {
      const pages = (await this.cdp.send('Target.getTargets')).targetInfos.filter(isPage);
      closed = !pages.some((t) => t.targetId === tab.targetId);
      if (!this.tab && closed && back && pages.some((t) => t.targetId === back)) return await this.attach(back);
    } catch {}
    if (this.tab) return;
    this.lost = closed ? 'The hidden tab was closed.' : why;
    this.announce();
  }

  async onEvent(method, p, sid) {
    const tab = this.tab;
    if (method === 'Network.requestWillBeSent') {
      if (tab && sid === tab.sid && p.type === 'Document' && p.frameId === tab.targetId) {
        const posted = p.request?.method === 'POST';
        if (posted !== this.posted) { this.posted = posted; this.announce(); }
      }
    } else if (method === 'Target.targetCreated') {
      const t = p.targetInfo;
      // A link that opens a new tab: follow it, as a pane does. It is the agent's to close too.
      if (tab && isPage(t) && t.openerId === tab.targetId) { this.owned.add(t.targetId); await this.attach(t.targetId, tab.targetId); }
    } else if (method === 'Target.targetDestroyed') {
      this.owned.delete(p.targetId);
      if (tab && p.targetId === tab.targetId) await this.lost_(tab, 'The hidden tab was closed.');
    } else if (method === 'Target.detachedFromTarget') {
      if (tab && p.sessionId === tab.sid) await this.lost_(tab, 'Chrome let go of the hidden tab (it may have discarded it to save memory).');
    } else if (method === 'Page.javascriptDialogOpening' && tab && sid === tab.sid) {
      this.dialog = { type: p.type, message: p.message };
      this.announce();
    } else if (method === 'Page.javascriptDialogClosed' && tab && sid === tab.sid) {
      this.dialog = null;
      this.announce();
    }
  }

  /** What an agent asks of it: open an address while it holds no tab, or answer the page's dialog. */
  readAsk() {
    const mine = readAsk(`pane-${process.pid}`);
    if (mine) {
      writeAsk(`pane-${process.pid}`, null);
      this.usedAt = Date.now();
      const url = typeof mine.open === 'string' && Date.now() - mine.at < 15000 ? normalizeUrl(mine.open) : null;
      if (url && /^(https?:|about:blank$)/i.test(url) && !this.tab && this.state === 'ready') this.open(url).catch(() => {});
    }
    const tab = this.tab;
    if (!tab) return;
    const ask = readAsk(tab.targetId);
    if (!ask) return;
    writeAsk(tab.targetId, null);
    if (!ask.dialog || !this.dialog || Date.now() - ask.at > 10000) return;
    const text = typeof ask.dialog.text === 'string' ? { promptText: ask.dialog.text } : {};
    this.cdp.send('Page.handleJavaScriptDialog', { accept: Boolean(ask.dialog.accept), ...text }, tab.sid).catch(() => {});
  }

  /** Each second: has a pane taken the tab over, and has an agent been at work in it lately. */
  check() {
    const tab = this.tab;
    if (tab) {
      // A pane shows the tab: the person has it now, and it is theirs to close.
      if (listPanes().some((p) => !p.hidden && p.targetId === tab.targetId)) return this.quit();
      const note = readNote(tab.targetId);
      if (note?.at > this.usedAt) this.usedAt = note.at;
    }
    if (Date.now() - Math.max(this.usedAt, this.shownAt ?? 0) > idleMs()) this.quit({ closeTabs: true });
  }

  /** Goes. `closeTabs`: the tabs it opened go too (the person never saw them); else they are left as they are. */
  async quit({ closeTabs = false } = {}) {
    if (this.quitting) return;
    this.quitting = true;
    unregisterPane();
    if (this.cdp && !this.cdp.closed) {
      const work = closeTabs
        ? Promise.all([...this.owned].map((targetId) => this.cdp.send('Target.closeTarget', { targetId }).catch(() => {})))
        : this.detach();
      await Promise.race([work, sleep(1500)]);
    }
    process.exit(0);
  }
}
