// The agent's side of chrome-pane: one command, one short answer in text.
//
// An agent does not look at the picture. It asks for the controls the page shows (`snapshot`),
// acts on one by its ref (`click e12`), and is told only what changed. Each command is its own
// process: it attaches a DevTools session of its own to the tab the pane shows, beside the
// viewer's, through the bridge, and detaches when it is done. The person keeps watching, and
// their mouse and keys keep working.
//
// A ref is a letter and a number: the number is Chrome's own id of the element, which stays the
// same for as long as the element lives, and the letter names the document it was given for
// (e, then f for the next page loaded in the tab...). So a ref needs no table kept between
// commands, and one from an earlier page is refused instead of pointing at some other element.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canConnect } from './bridge.mjs';
import { connect } from './cdp.mjs';
import { hostOf } from './hosts.mjs';
import { keyCalls } from './keys.mjs';
import { listPanes, ours, readBefore, readDoc, writeAsk, writeBefore, writeDoc, writeNote } from './panes.mjs';
import { logPath, socketPath, stateDir } from './paths.mjs';
import { clean, oneLine, pngSize } from './util.mjs';

export const VERBS = new Set(['open', 'snapshot', 'find', 'read', 'click', 'hover', 'fill', 'type', 'press', 'select', 'check', 'uncheck',
  'scroll', 'wait', 'back', 'forward', 'reload', 'batch', 'shot', 'eval', 'dialog', 'done', 'close', 'show']);
const ACTS = new Set(['click', 'hover', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'scroll', 'wait']);
const TYPING = new Set(['fill', 'type', 'press']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LETTERS = 'efghijklmnopqrstuvwxyzabcd';

/** A failure the agent is told in a line. code 2: there is no pane or no bridge to talk to. */
class Fail extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}
/** A ref that is not of the page the tab shows now. */
class Stale extends Fail {}
/** A name no control of the page has: it may be about to (a list that opens, a search that answers). */
class NotThere extends Fail {}
/** The page stopped at an alert or a question: nothing in it answers until that is answered. */
class DialogOpen extends Fail {}

// Outside a multiplexer `open` works in a hidden tab: there is no pane to open there.
const noPane = () => (hostOf()
  ? `No Chrome pane in this ${hostOf().name} tab. Run: chrome-pane open <url>`
  : 'No Chrome pane here. Run: chrome-pane open <url> (it works in a hidden tab of Chrome)');
const ASK_ALLOW = 'Chrome is asking the person to allow the connection (its “Allow remote debugging?” prompt, on the computer Chrome runs on). Once they have, run the command again.';

// ---------------------------------------------------------------- arguments

const FLAGS = new Set(['all', 'text', 'urls', 'table', 'idle', 'png', 'json', 'resend', 'hidden']);
const VALUES = new Set(['in', 'role', 'from', 'timeout', 'gone', 'url', 'scale', 'out', 'socket', 'user-data-dir']);

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o._.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--') || a.length < 3) { o._.push(a); continue; }
    const name = a.slice(2);
    if (FLAGS.has(name)) o[name] = true;
    else if (VALUES.has(name)) {
      if (argv[i + 1] === undefined) throw new Fail(`${a} needs a value`);
      o[name === 'user-data-dir' ? 'userDataDir' : name] = argv[++i];
    } else throw new Fail(`unknown option ${a}`);
  }
  return o;
}

/** A line of a batch as words: spaces part them, quotes keep them together. */
export function words(line) {
  const out = [];
  let cur = null, quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; cur ??= ''; }
    else if (/\s/.test(ch)) { if (cur !== null) { out.push(cur); cur = null; } }
    else cur = (cur ?? '') + ch;
  }
  if (quote) throw new Fail(`a quote is left open in: ${line}`);
  if (cur !== null) out.push(cur);
  return out;
}

/** Only the web: an agent has no business with file:, chrome: or javascript: addresses. */
export function webAddress(input) {
  const s = String(input ?? '').trim();
  if (!s) throw new Fail('open needs an address');
  if (s === 'about:blank') return s;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s) ? s : `${local ? 'http' : 'https'}://${s}`;
  let u;
  try { u = new URL(withScheme); } catch { throw new Fail(`not an address: ${s}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Fail(`open takes http and https addresses only, not ${u.protocol}`);
  if (!u.hostname.includes('.') && !local && u.hostname !== 'localhost') throw new Fail(`not an address: ${s} (give a full one, like https://example.com)`);
  return u.href;
}

// ---------------------------------------------------------------- the tab

class Tab {
  constructor(cdp, targetId, sid) {
    this.cdp = cdp; this.targetId = targetId; this.sid = sid;
    this.loading = false; this.dialog = null; this.ctx = null;
    this.waiting = new Set();
    // What the page has asked the network for and not been given yet (once `track` is on), and
    // when it last showed a sign of life: a load or a request that ended.
    this.asked = new Map(); this.stir = 0; this.begin();
    cdp.on('event', (method, p, sid2) => {
      // The tab closed, or Chrome let go of it: whatever waits for the page hears it at once.
      if ((method === 'Target.detachedFromTarget' && p.sessionId === sid) || (method === 'Target.targetDestroyed' && p.targetId === targetId)) {
        this.gone = true;
        for (const stop of [...this.waiting]) stop(new Fail('the tab was closed', 2));
      }
      if (sid2 !== sid) return;
      if (method === 'Page.frameStartedLoading' && p.frameId === this.frameId) this.loading = true;
      else if (method === 'Page.frameStoppedLoading' && p.frameId === this.frameId) {
        this.loading = false; this.stir = Date.now();
        // A page has loaded (not: the address changed within one): what it asks for now is the load's own.
        if (this.fresh) { this.fresh = false; this.begin(); for (const r of this.asked.values()) r.first = true; }
      }
      // A new page: what the one before it had asked for is no longer waited for.
      else if (method === 'Page.frameNavigated' && p.frame?.id === this.frameId) { this.asked.clear(); this.fresh = true; }
      else if (method === 'Network.requestWillBeSent') { if (asks(p)) this.asked.set(p.requestId, { answered: 0, at: Date.now(), ours: sameSite(p.request?.url, p.documentURL), first: this.fresh || (!this.closed && Date.now() - this.since < 400) }); }
      else if (method === 'Network.responseReceived' || method === 'Network.dataReceived') { const r = this.asked.get(p.requestId); if (r) { r.answered ||= Date.now(); r.fed = Date.now(); } }
      else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        const r = this.asked.get(p.requestId);
        if (r) { this.asked.delete(p.requestId); this.stir = Date.now(); if (r.first) { this.done = this.stir; if (r.at >= this.since) this.closed = true; } }
      }
      else if (method === 'Page.javascriptDialogOpening') {
        this.dialog = { type: p.type, message: p.message };
        for (const stop of [...this.waiting]) stop();
      } else if (method === 'Page.javascriptDialogClosed') this.dialog = null;
    });
  }

  static async attach(cdp, targetId) {
    let sid;
    try { ({ sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })); }
    catch { throw new Fail('The tab of the pane is gone. Run: chrome-pane open <url>', 2); }
    const tab = new Tab(cdp, targetId, sid);
    await tab.send('Page.enable');
    await tab.identify();
    tab.turned = false;
    return tab;
  }

  /** A DevTools call on this tab. A page stopped at a dialog answers nothing: the call ends there, and every call has a limit. */
  send(method, params = {}, ms = 10000) {
    if (this.gone) return Promise.reject(new Fail('the tab was closed', 2));
    if (this.dialog) return Promise.reject(new DialogOpen(dialogLine(this.dialog)));
    let timer, stop;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Fail(`the page did not answer ${method} in ${ms / 1000} s`)), ms);
      stop = (why) => reject(why ?? new DialogOpen(dialogLine(this.dialog)));
    });
    this.waiting.add(stop);
    return Promise.race([this.cdp.send(method, params, this.sid), late]).finally(() => { clearTimeout(timer); this.waiting.delete(stop); });
  }

  /** Finds out which document the tab shows, and so the letter its refs carry. True when it is a new one. */
  async identify() {
    const { frameTree } = await this.send('Page.getFrameTree');
    const loaderId = frameTree.frame.loaderId;
    this.frameId = frameTree.frame.id;
    const doc = readDoc(this.targetId);
    const changed = this.loaderId ? this.loaderId !== loaderId : Boolean(doc && doc.loaderId !== loaderId);
    let gen = doc?.gen ?? 0;
    if (doc && doc.loaderId !== loaderId) gen = (doc.gen + 1) % LETTERS.length;
    if (!doc || doc.loaderId !== loaderId) writeDoc(this.targetId, { loaderId, gen });
    this.loaderId = loaderId;
    this.letter = LETTERS[gen];
    this.ctx = null;
    // `turned`: the tab went to another page while this command ran.
    if (changed) this.turned = true;
    return changed;
  }

  /**
   * An action begins, or a page has loaded. What the page asks for at once is the action's own:
   * until the first of those answers is in, or for a moment (a search waits for the typing to end).
   */
  begin() { this.since = this.done = Date.now(); this.closed = false; }

  /** From here on, knows what the page asks the network for: an action is over when its answers are in. */
  async track() {
    if (!this.tracking) { this.tracking = true; await this.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }).catch(() => {}); }
  }

  /**
   * How many answers the page still waits for. One that began to come is waited for while more
   * of it arrives, and not for long: the page may never read it to its end (a save it only
   * needed a yes from), or it has none (a chat's reply, a feed).
   */
  pending(others = 2500, later = 700) {
    let n = 0;
    const now = Date.now();
    for (const r of this.asked.values()) {
      // Another site's answer (a counter of visits, an ad, a widget) is seldom what the page shows next.
      if (!r.ours && now - r.at >= others) continue;
      // Nor, for long, what the page asked for afterwards: what it may show next (GitHub fetches
      // the issues of a list ahead), a report of what the user did, the next turn of a poll.
      if (!r.first && now - this.done >= later) continue;
      if (!r.answered || (now - r.fed < 150 && now - r.answered < 1500)) n++;
    }
    return n;
  }

  /** A JavaScript world of our own in the page: its scripts cannot see or change what runs here. */
  async world() {
    if (!this.ctx) this.ctx = (await this.send('Page.createIsolatedWorld', { frameId: this.frameId, worldName: 'chrome-pane' })).executionContextId;
    return this.ctx;
  }

  async invoke(params) {
    let r;
    try { r = await this.send('Runtime.callFunctionOn', { returnByValue: true, awaitPromise: true, ...params }); }
    catch (e) {
      if (e instanceof Fail || !/context|Cannot find/i.test(e.message)) throw e;
      this.ctx = null; // the page moved on under us: once more in its new world
      if (params.executionContextId) params.executionContextId = await this.world();
      r = await this.send('Runtime.callFunctionOn', { returnByValue: true, awaitPromise: true, ...params });
    }
    if (r.exceptionDetails) throw new Fail(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split('\n')[0]);
    return r.result.value;
  }

  /** Runs a function in the page, with `args`. */
  async run(fn, ...args) {
    return this.invoke({ functionDeclaration: String(fn), executionContextId: await this.world(), arguments: args.map((value) => ({ value })) });
  }

  /** Runs a function in the page with `this` set to the element of a ref. */
  async on(id, fn, ...args) {
    let object;
    try { ({ object } = await this.send('DOM.resolveNode', { backendNodeId: id, executionContextId: await this.world() })); }
    catch (e) { if (e instanceof Fail) throw e; throw new Stale(`${this.letter}${id} is no longer in the page`); }
    return this.invoke({ functionDeclaration: String(fn), objectId: object.objectId, arguments: args.map((value) => ({ value })) });
  }

  /** The element id of a ref, refusing one of another document. */
  ref(text) {
    const m = /^@?([a-z])(\d+)$/.exec(String(text ?? ''));
    // h1 to h6 are headings' tags, never refs anyone was given (those numbers are the document's own nodes).
    if (!m || /^h[1-6]$/.test(text)) throw new Fail(`not a ref: ${text} (refs look like ${this.letter}12; take them from a snapshot)`);
    if (m[1] !== this.letter) throw new Stale(`${text} is of an earlier page`);
    return Number(m[2]);
  }
}

// What a page asks for after an action that its next state depends on: data, and code to show it.
const ASKS = new Set(['XHR', 'Fetch', 'Script']);
/**
 * Whether a request is one whose answer the page waits for. Not a worker's own script (it has
 * no loader, and its answer goes to the worker, never to the page), and not an extension's.
 */
const asks = (p) => ASKS.has(p.type) && !!p.loaderId && /^https?:/i.test(p.request?.url ?? '');
/** Whether two addresses are of one site, by the last two names of their hosts (which takes a.co.uk and b.co.uk for one: it errs on the side of waiting). */
function sameSite(a, b) {
  try { const site = (u) => new URL(u).hostname.split('.').slice(-2).join('.'); return site(a) === site(b); } catch { return true; }
}

const dialogLine = (d) => `The page shows a dialog (${d.type}): ${JSON.stringify(String(d.message).slice(0, 200))}. Answer it: chrome-pane dialog accept, or dialog dismiss`;

// ---------------------------------------------------------------- reading the page

const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'listbox', 'treeitem', 'textarea', 'DisclosureTriangle', 'PopUpButton', 'ColorWell', 'Date', 'DateTime', 'InputTime']);
const LANDMARK = new Set(['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'form', 'region', 'dialog', 'alertdialog', 'alert', 'status', 'table', 'grid', 'list', 'menu', 'menubar', 'tablist', 'toolbar', 'tree', 'article']);
const ALWAYS = new Set(['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'dialog', 'alertdialog', 'alert', 'status']);
const SKIP = new Set(['InlineTextBox', 'LineBreak', 'none', 'presentation']);
// What can take the focus and yet is not one control but a holder of them (a dialog a page
// focuses when it opens, a list of suggestions): its controls have their own lines.
const HOLDS = new Set([...LANDMARK, 'listbox', 'radiogroup', 'group', 'tabpanel', 'treegrid', 'document', 'application']);
const VALUED = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'textarea']);
const INLINE = new Set(['strong', 'emphasis', 'code', 'mark', 'subscript', 'superscript', 'time', 'insertion', 'deletion']);

// A field for a password, a code sent to a phone or a card, by what it says of itself.
const SECRET = /(^|\s)(cc-|one-time-code|\S*password)/;
// The same by the field's name or id, for pages that say nothing in autocomplete (and for a
// password shown as text by a "show" button).
const SECRET_NAME = /passw|pwd|card.?num|cc.?(num|csc|cvc|cvv)|(^|[^a-z])(cvc|cvv|csc|otp)([^a-z]|$)|security.?code|one.?time/;
const NOT_OURS = 'holds a password, a code or a card: ask the person to type it in the pane';

const prop = (n, name) => n.properties?.find((p) => p.name === name)?.value?.value;
const quote = (s, max = 80) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return JSON.stringify(s.length > max ? `${s.slice(0, max - 1)}…` : s); };
const isControl = (n) => INTERACTIVE.has(n.role?.value) || (prop(n, 'focusable') === true && !['RootWebArea', 'generic', 'none', 'Iframe'].includes(n.role?.value));
/** What kind of control this is, in the word the agent reads: its role, or `clickable` for one the page made of plain elements. */
const kindOf = (cap, n) => (cap.pressable.has(n.nodeId) ? 'clickable' : !n.ignored && isControl(n) && !SKIP.has(n.role?.value) ? n.role.value : null);
/** The name a control goes by: the one it gives itself, or the text it shows. */
const nameOf = (cap, n) => n.name?.value?.trim() || (cap.pressable.has(n.nodeId) ? textIn(cap, n, 80) : '');

/**
 * Reads the page: the accessibility tree (roles, names, states), each element's box (to know
 * what is in view) and which fields hold secrets.
 */
async function capture(tab) {
  const [{ nodes }, snap, view] = await Promise.all([
    tab.send('Accessibility.getFullAXTree'),
    tab.send('DOMSnapshot.captureSnapshot', { computedStyles: ['cursor'] }),
    tab.run(function () {
      const e = document.documentElement;
      return { sx: scrollX, sy: scrollY, vw: innerWidth, vh: innerHeight, dh: e.scrollHeight, rw: e.getBoundingClientRect().width, title: document.title, url: location.href };
    }),
  ]);
  const doc = snap.documents[0], strings = snap.strings;
  const box = new Map(), secret = new Set();
  let rootWidth = 0;
  const { nodeIndex, bounds } = doc.layout;
  for (let i = 0; i < nodeIndex.length; i++) {
    const at = nodeIndex[i], id = doc.nodes.backendNodeId[at];
    if (!box.has(id)) box.set(id, bounds[i]);
    if (!rootWidth && strings[doc.nodes.nodeName[at]] === 'HTML') rootWidth = bounds[i][2];
  }
  // The boxes come in the screen's pixels on some Chromes and in the page's on others: the
  // root element, whose width the page itself reports, says which.
  const k = rootWidth > 0 && view.rw > 0 ? rootWidth / view.rw : 1;
  if (Math.abs(k - 1) > 0.01) for (const b of box.values()) for (let i = 0; i < 4; i++) b[i] /= k;
  const attributes = doc.nodes.attributes ?? [];
  for (let at = 0; at < attributes.length; at++) {
    const a = attributes[at];
    if (!a?.length || !['INPUT', 'TEXTAREA'].includes(strings[doc.nodes.nodeName[at]])) continue;
    for (let i = 0; i + 1 < a.length; i += 2) {
      const name = strings[a[i]]?.toLowerCase(), value = strings[a[i + 1]]?.toLowerCase() ?? '';
      if ((name === 'type' && value === 'password') || (name === 'autocomplete' && SECRET.test(value))
        || ((name === 'name' || name === 'id') && SECRET_NAME.test(value))) secret.add(doc.nodes.backendNodeId[at]);
    }
  }
  // Controls a page makes of plain elements say nothing of themselves to the accessibility
  // tree: they are known by the click they listen for, or by the hand the pointer becomes over
  // them (where it is theirs, not handed down from what holds them).
  const hand = new Set(), press = new Set(), listens = new Set(doc.nodes.isClickable?.index ?? []);
  for (let i = 0; i < nodeIndex.length; i++) if (strings[doc.layout.styles[i]?.[0]] === 'pointer') hand.add(nodeIndex[i]);
  for (const at of new Set([...listens, ...hand])) {
    if (doc.nodes.nodeType[at] !== 1 || ['HTML', 'BODY', 'LABEL'].includes(strings[doc.nodes.nodeName[at]])) continue;
    if (!listens.has(at) && hand.has(doc.nodes.parentIndex[at])) continue;
    press.add(doc.nodes.backendNodeId[at]);
  }
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const cap = { nodes, byId, root: nodes.find((n) => !n.parentId) ?? nodes[0], box, secret, view, pressable: new Set() };
  // Of those, the ones to show: with a size and words of their own, outside any control, and
  // holding none (what holds controls is a wrapper that listens for them all).
  const scan = (n, inside) => {
    const control = !n.ignored && isControl(n);
    let holds = false;
    for (const c of kids(cap, n)) if (scan(c, inside || control)) holds = true;
    if (control || holds || inside || !press.has(n.backendDOMNodeId)) return control || holds;
    const b = box.get(n.backendDOMNodeId);
    if (!b || b[2] <= 0 || b[3] <= 0 || !(n.name?.value?.trim() || textIn(cap, n, 80))) return false;
    cap.pressable.add(n.nodeId);
    return true;
  };
  scan(cap.root, false);
  return cap;
}

const kids = (cap, n) => (n.childIds ?? []).map((id) => cap.byId.get(id)).filter(Boolean);

/** Where an element is against what the pane shows: 'in', 'above', 'below', 'aside', 'none' (no size) or null (no box of its own). */
function place(cap, n) {
  const b = cap.box.get(n.backendDOMNodeId);
  if (!b) return null;
  const [x, y, w, h] = b, v = cap.view;
  if (w <= 0 || h <= 0) return 'none';
  if (y >= v.sy + v.vh) return 'below';
  if (y + h <= v.sy) return 'above';
  return x < v.sx + v.vw && x + w > v.sx ? 'in' : 'aside';
}

function states(cap, n) {
  let s = '';
  const value = n.value?.value;
  if (value !== undefined && value !== '' && VALUED.has(n.role?.value)) s += cap.secret.has(n.backendDOMNodeId) ? ' =[filled]' : ` =${quote(value, 60)}`;
  const checked = prop(n, 'checked');
  if (checked === 'true' || checked === true) s += ' [checked]'; else if (checked === 'mixed') s += ' [mixed]';
  if (prop(n, 'disabled')) s += ' [disabled]';
  const expanded = prop(n, 'expanded');
  if (expanded === true) s += ' [expanded]'; else if (expanded === false) s += ' [collapsed]';
  if (prop(n, 'selected') === true) s += ' [selected]';
  if (prop(n, 'required')) s += ' [required]';
  if (prop(n, 'invalid') && prop(n, 'invalid') !== 'false') s += ' [invalid]';
  if (prop(n, 'focused')) s += ' [focused]';
  return s;
}

const controlLine = (cap, tab, n, o = {}) => {
  const name = nameOf(cap, n);
  const url = o.urls && n.role?.value === 'link' ? prop(n, 'url') : null;
  return `${tab.letter}${n.backendDOMNodeId} ${kindOf(cap, n) ?? n.role.value}${name ? ` ${quote(name)}` : ''}${states(cap, n)}${url ? ` → ${String(url).slice(0, 120)}` : ''}`;
};

// What the page tells the person: a message that came up, the state of something, and whatever
// part of it the page marks as news to be read out when it changes.
const SAYS = new Set(['alert', 'status', 'alertdialog']);
const says = (n) => SAYS.has(n.role?.value) || ['polite', 'assertive'].includes(prop(n, 'live'));

/** The text inside an element, as far as `max` characters. */
function textIn(cap, n, max = 200) {
  let text = '';
  const walk = (x) => {
    if (text.length > max) return;
    if (x.role?.value === 'StaticText') text += `${x.name?.value ?? ''} `;
    else for (const c of kids(cap, x)) walk(c);
  };
  walk(n);
  return text.replace(/\s+/g, ' ').trim();
}

const saysLine = (cap, tab, n) => {
  const text = n.backendDOMNodeId && place(cap, n) !== 'none' ? textIn(cap, n) : '';
  return text ? `${tab.letter}${n.backendDOMNodeId} ${SAYS.has(n.role?.value) ? n.role.value : 'status'} ${quote(text, 200)}` : null;
};

/**
 * Every control of the page as its line, by ref, and every message the page shows: what two
 * moments of a page are compared by. All of the page, not only what is in view, so that a
 * scroll changes nothing; and without where the focus is, which every click moves. With them,
 * the page's other words, a block of text at a time: what an action made it say.
 */
function controlLines(cap, tab) {
  const lines = new Map(), words = new Map();
  const walk = (n, quiet, holder) => {
    const role = n.role?.value;
    let told = quiet;
    if (!quiet && n.backendDOMNodeId) {
      if (kindOf(cap, n)) { told = !HOLDS.has(role); if (place(cap, n) !== 'none') lines.set(`${tab.letter}${n.backendDOMNodeId}`, controlLine(cap, tab, n).replace(' [focused]', '')); }
      else if (!n.ignored && says(n)) { told = true; const line = saysLine(cap, tab, n); if (line) lines.set(`${tab.letter}${n.backendDOMNodeId}`, line); }
    }
    // A block's words are its own: not those of the controls and messages in it, which have
    // their lines, nor those of a block inside it. What only marks a few words is no block.
    if (!n.ignored && n.backendDOMNodeId && role !== 'StaticText' && !SKIP.has(role) && !INLINE.has(role)) holder = n;
    if (role === 'StaticText' && !told && holder) { if (!words.has(holder)) words.set(holder, []); words.get(holder).push(n.name?.value ?? ''); }
    // The options of a closed list say again what the list's own line says.
    const closed = quiet || (role === 'combobox' && prop(n, 'expanded') !== true);
    for (const c of kids(cap, n)) walk(c, closed || told, holder);
  };
  walk(cap.root, false, null);
  lines.texts = new Set();
  for (const [holder, pieces] of words) {
    const text = pieces.join(' ').replace(/\s+/g, ' ').trim();
    if (text && place(cap, holder) !== 'none') lines.texts.add(text);
  }
  return lines;
}

/**
 * The page as lines: the controls, under the landmarks and headings that hold them, each with
 * its ref. Only what is in view unless `all`; `within` keeps one part.
 */
function render(cap, tab, o = {}) {
  const all = Boolean(o.all || o.within), max = o.max ?? 6000, run = 12;
  const id = (n) => (n.backendDOMNodeId ? `${tab.letter}${n.backendDOMNodeId}` : null);
  const lead = (n) => (n.backendDOMNodeId ? `${tab.letter}${n.backendDOMNodeId} ` : '');
  let shown = 0, total = 0, above = 0, below = 0, farHeadings = 0, moreHeadings = 0;
  // `held`: where the control that holds this one is, for what has no box of its own.
  const build = (n, held = null) => {
    const kind = kindOf(cap, n), role = kind ?? n.role?.value;
    if (!kind && (n.ignored || SKIP.has(role))) return kids(cap, n).flatMap((k) => build(k, held));
    if (role === 'StaticText') {
      if (!o.text) return [];
      const t = n.name?.value?.trim(), where = place(cap, cap.byId.get(n.parentId) ?? n);
      return t && (all || where === 'in' || where === null) ? [{ line: quote(t, 160), kids: [], kind: 'text' }] : [];
    }
    const control = kind && n.backendDOMNodeId;
    // The options of a closed list have no box: they are where their list is.
    const where = control ? place(cap, n) ?? held : null;
    const children = kids(cap, n).flatMap((k) => build(k, control ? where : held));
    const name = nameOf(cap, n);
    if (control) {
      if (where === 'none') return children;
      total++;
      if (!all && where !== 'in' && where !== null) { if (where === 'above') above++; else below++; return children; }
      shown++;
      // A control's own text and a lone child of the same name repeat it.
      return [{ line: controlLine(cap, tab, n, o), name, ref: id(n), kids: children.filter((c) => c.kind !== 'text' && !(c.name && c.name === name && !c.kids.length)), kind: role }];
    }
    if (role === 'heading') {
      const where = place(cap, n), level = prop(n, 'level') ?? '';
      if (all || where === 'in' || where === null) return [{ line: `${lead(n)}h${level} ${quote(name)}`, kids: [], kind: 'heading' }, ...children];
      // Out of view, the main headings are the map of the page.
      if (level > 2 || where === 'none' || farHeadings >= 20) { if (where !== 'none') moreHeadings++; return children; }
      farHeadings++;
      return [{ line: `${lead(n)}h${level} ${quote(name)} (${where === 'above' ? '↑' : '↓'})`, kids: [], kind: 'heading' }, ...children];
    }
    // A message with nothing to press in it is still said: it is what the page answers with.
    if (says(n) && !children.length && !o.text) {
      const line = all || ['in', null].includes(place(cap, n)) ? saysLine(cap, tab, n) : null;
      return line ? [{ line, kids: [], kind: 'says' }] : [];
    }
    if ((ALWAYS.has(role) || (name && (LANDMARK.has(role) || role === 'group' || role === 'radiogroup'))) && children.length) return [{ line: `${lead(n)}${role}${name ? ` ${quote(name, 40)}` : ''}`, ref: id(n), kids: children, kind: 'group' }];
    return children;
  };
  let start = cap.root;
  if (o.within) {
    start = cap.nodes.find((n) => n.backendDOMNodeId === o.within && !n.ignored) ?? cap.nodes.find((n) => n.backendDOMNodeId === o.within);
    if (!start) throw new Stale(`${tab.letter}${o.within} is no longer in the page`);
  }
  const tree = build(start);
  const lines = [];
  const emit = (items, depth, holder) => {
    let i = 0;
    while (i < items.length) {
      // A wall of alike things (forty links in a row) is cut to its first few.
      let j = i;
      while (j < items.length && items[j].kind === items[i].kind && !items[j].kids.length && !['heading', 'group', 'text', 'says'].includes(items[j].kind)) j++;
      if (!o.within && j - i > run) {
        for (let k = i; k < i + run - 2; k++) lines.push(' '.repeat(depth) + items[k].line);
        lines.push(`${' '.repeat(depth)}… ${j - (i + run - 2)} more ${items[i].kind}s here (${holder ? `snapshot --in ${holder}, or ` : ''}find <text>)`);
        i = j; continue;
      }
      const it = items[i++];
      lines.push(' '.repeat(depth) + it.line);
      emit(it.kids, depth + 1, it.ref ?? holder);
    }
  };
  emit(tree, 0, null);
  const v = cap.view;
  const head = [v.title || '(no title)', v.url.length > 120 ? `${v.url.slice(0, 119)}…` : v.url,
    `view ${v.vw}x${v.vh} at ${Math.round(v.sy)} of ${v.dh} px · ${shown} of ${total} controls${all ? '' : ` in view (${above} above, ${below} below)`}`];
  let body = lines, cut = [];
  if (max && body.join('\n').length > max) {
    let n = 0, keep = 0;
    while (keep < body.length && n + body[keep].length + 1 <= max) n += body[keep++].length + 1;
    cut = [`… cut at ${max} characters: ${body.length - keep} more lines (narrow with snapshot --in <ref>, or find <text>)`];
    body = body.slice(0, keep);
  }
  if (moreHeadings) cut.push(`… ${moreHeadings} more headings out of view (snapshot --all, or find <text>)`);
  return [...(o.within ? [] : head), ...body, ...cut].join('\n');
}

const WHERE = { in: 'in view', above: '↑ above', below: '↓ below', aside: 'out of view, to the side', none: 'hidden' };
const CELLS = new Set(['cell', 'gridcell', 'rowheader', 'columnheader']);
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The row a cell of a table is in, as its cells' words: what a found cell is asked for, most times. */
function rowOf(cap, n) {
  if (!CELLS.has(n.role?.value)) return null;
  let row = cap.byId.get(n.parentId);
  for (let up = 0; row && row.role?.value !== 'row' && up < 3; up++) row = cap.byId.get(row.parentId);
  if (row?.role?.value !== 'row') return null;
  const cells = kids(cap, row).filter((c) => CELLS.has(c.role?.value)).map((c) => textIn(cap, c, 60));
  return cells.length > 1 ? cells.join(' | ').slice(0, 300) : null;
}

/** The first heading in an element, a few levels down at most. */
function headingIn(cap, n, depth = 3) {
  if (n.role?.value === 'heading' && !n.ignored) return n.name?.value?.trim() || null;
  if (depth) for (const c of kids(cap, n)) { const h = headingIn(cap, c, depth - 1); if (h) return h; }
  return null;
}

/** What tells two controls of the same name apart: the row, the named part of the page or the heading each is under. */
function setting(cap, n) {
  for (let child = n, a = cap.byId.get(n.parentId), up = 0; a && up < 15; child = a, a = cap.byId.get(a.parentId), up++) {
    const role = a.role?.value, name = a.name?.value?.trim();
    if (a.ignored) continue;
    if (role === 'row') return textIn(cap, a, 60);
    if (name && role !== 'RootWebArea' && (LANDMARK.has(role) || role === 'group' || role === 'radiogroup')) return name;
    const sibs = kids(cap, a);
    for (let i = sibs.indexOf(child) - 1; i >= 0; i--) { const h = headingIn(cap, sibs[i]); if (h) return h; }
  }
  return null;
}

/** Lines of look-alikes, each with what sets it apart, where the others' line is the same. */
function apart(cap, items) {
  const seen = new Map(), bare = (it) => it.line.replace(/^\S+ /, '');
  for (const it of items) seen.set(bare(it), (seen.get(bare(it)) ?? 0) + 1);
  return items.map((it) => {
    const under = seen.get(bare(it)) > 1 && !it.row ? setting(cap, it.node) : null;
    return `${it.line}  (${WHERE[place(cap, it.node)] ?? 'in view'}${under ? `, under ${quote(under, 50)}` : ''})`;
  });
}

/** The elements whose name, value or text has `text`: up to 20, each with where it is. */
function search(cap, tab, text, o = {}) {
  const want = text.toLowerCase(), hits = new Map();
  for (const n of cap.nodes) {
    if (n.ignored && !cap.pressable.has(n.nodeId)) continue;
    let target = n;
    // A piece of text is found through the element that holds it.
    if (n.role?.value === 'StaticText') { target = cap.byId.get(n.parentId); while (target && !cap.pressable.has(target.nodeId) && (target.ignored || !target.backendDOMNodeId)) target = cap.byId.get(target.parentId); }
    if (!target?.backendDOMNodeId || (SKIP.has(target.role?.value) && !cap.pressable.has(target.nodeId)) || target.role?.value === 'RootWebArea') continue;
    const kind = kindOf(cap, target);
    if (o.role && (kind ?? target.role?.value) !== o.role) continue;
    const hay = `${n.name?.value ?? ''} ${cap.secret.has(n.backendDOMNodeId) ? '' : n.value?.value ?? ''}`.toLowerCase();
    if (!hay.includes(want)) continue;
    const where = place(cap, target);
    if (where === 'none' || hits.has(target.backendDOMNodeId)) continue;
    const row = kind ? null : rowOf(cap, target);
    const line = kind ? controlLine(cap, tab, target, o) : `${tab.letter}${target.backendDOMNodeId} ${target.role?.value ?? 'text'} ${quote(target.name?.value || n.name?.value, 100)}`;
    hits.set(target.backendDOMNodeId, { line, node: target, control: Boolean(kind), row, exact: norm(nameOf(cap, target) || n.name?.value) === norm(want) });
  }
  // Controls first, and among them the ones named exactly so.
  const found = [...hits.values()].sort((a, b) => (b.control - a.control) || (b.exact - a.exact));
  // A named part of the page that was found (a form, a section) is shown with what it holds, when
  // that is little: the next thing asked is what is in it.
  const parts = [], held = new Set();
  if (found.length <= 8) for (const h of found) {
    const role = h.node.role?.value;
    if (h.control || !(LANDMARK.has(role) || role === 'group' || role === 'radiogroup') || !h.node.name?.value || held.has(h.node.backendDOMNodeId)) continue;
    const inside = render(cap, tab, { within: h.node.backendDOMNodeId, urls: o.urls, max: 0 }).split('\n');
    if (inside.length < 2 || inside.length > 16) continue;
    h.inside = inside.slice(1);
    const hold = (x) => { held.add(x.backendDOMNodeId); for (const c of kids(cap, x)) hold(c); };
    for (const c of kids(cap, h.node)) hold(c);
    parts.push(h);
  }
  const shown = found.filter((h) => !held.has(h.node.backendDOMNodeId)).slice(0, 20);
  const tails = apart(cap, shown);
  const lines = shown.flatMap((h, i) => [`${tails[i]}${h.row ? `  row: ${h.row}` : ''}`, ...(h.inside ?? [])]);
  const more = found.filter((h) => !held.has(h.node.backendDOMNodeId)).length - shown.length;
  if (more > 0) lines.push(`… ${more} more (a longer text, or --role <role>, narrows it)`);
  return lines.length ? lines.join('\n') : `nothing on the page has ${JSON.stringify(text)}${o.role ? ` with the role ${o.role}` : ''}`;
}

/** The roles an action can be meant for, when its control is given by name. */
const MEANT = {
  fill: VALUED,
  select: new Set(['combobox', 'listbox', 'PopUpButton']),
  check: new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']),
};
MEANT.uncheck = MEANT.check;

/**
 * The element an action is for, as [id, ref]: the one of a ref, or the one control that goes by
 * a name ("Next", "Email"). A name several controls have is refused with the list of them:
 * guessing which would be acting on the wrong one.
 */
function aim(cap, tab, text, verb) {
  text = String(text ?? '');
  if (/^@?[a-z]\d+$/.test(text) && !/^h[1-6]$/.test(text)) return [tab.ref(text), text.replace(/^@/, '')];
  const want = norm(text.replace(/^@/, ''));
  if (!want) throw new Fail(`${verb} needs a ref or a name`);
  if (!cap) throw new Fail(`not a ref: ${text}`);
  const fits = MEANT[verb], exact = [], part = [];
  for (const n of cap.nodes) {
    const kind = n.backendDOMNodeId ? kindOf(cap, n) : null;
    if (!kind || (fits && !fits.has(kind))) continue;
    const where = place(cap, n);
    if (where === 'none' || (where === null && kind === 'option')) continue;
    const name = norm(nameOf(cap, n));
    if (name === want) exact.push(n); else if (name.includes(want)) part.push(n);
  }
  // A click on what is only named something like it could be a click on the wrong thing
  // ("Delete" for "Delete account"): a field, a list or a checkbox may be meant by a part of its name.
  const press = verb === 'click' || verb === 'hover';
  let hits = exact.length || press ? exact : part;
  // Words that are no control's name may still be something to click: a plain piece of text.
  if (!hits.length && press) {
    const seen = new Set();
    for (const n of cap.nodes) {
      if (n.ignored || n.role?.value !== 'StaticText' || norm(n.name?.value) !== want) continue;
      let holder = cap.byId.get(n.parentId);
      while (holder && (holder.ignored || !holder.backendDOMNodeId)) holder = cap.byId.get(holder.parentId);
      if (!holder || seen.has(holder.backendDOMNodeId) || place(cap, holder) === 'none' || kindOf(cap, holder)) continue;
      seen.add(holder.backendDOMNodeId);
      hits.push(holder);
    }
  }
  const what = verb === 'fill' ? 'field' : verb === 'select' ? 'list' : fits ? 'checkbox or radio button' : 'control';
  const list = (nodes) => apart(cap, nodes.slice(0, 8).map((n) => ({ node: n, line: kindOf(cap, n) ? controlLine(cap, tab, n) : `${tab.letter}${n.backendDOMNodeId} ${n.role?.value ?? 'text'} ${quote(nameOf(cap, n) || text, 80)}` }))).join('\n') + (nodes.length > 8 ? `\n… ${nodes.length - 8} more` : '');
  if (!hits.length && press && part.length) throw new Fail(`no control of the page is named exactly ${JSON.stringify(text)}; these have it in their names, say which by its ref\n${list(part)}`);
  if (!hits.length) throw new NotThere(`no ${what} of the page is named ${JSON.stringify(text)} (a ref looks like ${tab.letter}12; chrome-pane find <text> searches the page)`);
  if (hits.length > 1) throw new Fail(`${hits.length} ${what}s are named ${JSON.stringify(text)}: say which by its ref\n${list(hits)}`);
  return [hits[0].backendDOMNodeId, `${tab.letter}${hits[0].backendDOMNodeId}`];
}

function cutText(text, o, what) {
  const max = 8000, from = Math.max(0, Number(o.from) || 0);
  const part = text.slice(from, from + max);
  const rest = text.length - (from + part.length);
  return part + (rest > 0 ? `\n… ${rest} more characters (${what} --from ${from + part.length})` : '');
}

// ---------------------------------------------------------------- acting on the page

/** In the page: brings the element to the middle of the view and says where to click it, or what is over it. */
function locate() {
  this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = this.getBoundingClientRect();
  if (!r.width || !r.height) return { error: 'it has no size (it may be hidden)' };
  const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1), y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
  let hit = document.elementFromPoint(x, y), ok = false;
  // The element itself, something inside it, or something it is inside of (through shadow roots too).
  for (let e = hit; e && !ok; e = e.parentNode || e.host) ok = e === this;
  for (let e = this; e && !ok; e = e.parentNode || e.host) ok = e === hit;
  return { x, y, covered: ok ? null : hit ? hit.tagName.toLowerCase() + (hit.id ? `#${hit.id}` : '') : 'nothing' };
}

async function point(tab, id, ref) {
  const at = await tab.on(id, locate);
  if (at.error) throw new Fail(`${ref}: ${at.error}`);
  if (at.covered) throw new Fail(`${ref} is covered by ${at.covered}: something is over it (a dialog or banner?). Take a snapshot.`);
  return at;
}

async function mouse(tab, at, click) {
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'none', buttons: 0 });
  if (!click) return;
  await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 });
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 });
}

const KEY_NAMES = { enter: 'Enter', return: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape', backspace: 'Backspace', delete: 'Delete', del: 'Delete', space: ' ',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert' };

/** "Enter", "ctrl+a", "shift+Tab" as a key event. */
export function keyEvent(text) {
  const parts = String(text).split('+');
  let name = parts.pop();
  if (name === '' && parts.length) { parts.pop(); name = '+'; }
  const ev = { type: 'key', name, shift: false, alt: false, ctrl: false, meta: false };
  for (const m of parts) {
    const k = m.toLowerCase();
    if (k === 'ctrl' || k === 'control') ev.ctrl = true;
    else if (k === 'alt' || k === 'option') ev.alt = true;
    else if (k === 'shift') ev.shift = true;
    else if (k === 'cmd' || k === 'meta' || k === 'command') ev.meta = true;
    else throw new Fail(`not a key: ${text}`);
  }
  ev.name = KEY_NAMES[name.toLowerCase()] ?? (/^f\d{1,2}$/i.test(name) ? name.toUpperCase() : name);
  if (!keyCalls(ev).length) throw new Fail(`not a key: ${text} (Enter, Tab, Escape, ArrowDown, ctrl+a to select all, a letter...)`);
  return ev;
}

async function press(tab, ev) {
  for (const c of keyCalls(ev)) await tab.send(c.method, c.params);
}

/**
 * Refuses when what has the keyboard is a field for a password, a code or a card, or sits in a
 * frame of another site, where this cannot look (a payment or sign-in form, as a rule).
 */
async function notSecret(tab) {
  const what = await tab.run(function (rule, names) {
    let e = document.activeElement;
    for (let i = 0; e && i < 20; i++) {
      if (e.shadowRoot?.activeElement) { e = e.shadowRoot.activeElement; continue; }
      if (e.tagName !== 'IFRAME' && e.tagName !== 'FRAME') break;
      let inner = null;
      try { inner = e.contentDocument; } catch {}
      if (!inner) return 'frame';
      e = inner.activeElement;
    }
    if (!e?.getAttribute) return null;
    const say = (k) => (e.getAttribute(k) ?? '').toLowerCase();
    return e.type === 'password' || new RegExp(rule).test(say('autocomplete')) || new RegExp(names).test(`${say('name')} ${say('id')}`) ? 'secret' : null;
  }, SECRET.source, SECRET_NAME.source);
  if (what === 'secret') throw new Fail(`the focused field ${NOT_OURS}`);
  if (what === 'frame') throw new Fail('the focused field is inside a frame of another site, which may be a payment or sign-in form: ask the person to type there, in the pane');
}

/** One action. Resolves to the line that says what was done. */
async function act(tab, cap, verb, a) {
  // The control: a ref, or its name. With one more word to say (a text, an option) the name is the first.
  // A name the page does not have yet is waited for, a moment: a list is opening, a search is answering.
  const needRef = async (rest = false) => {
    if (!a._[0]) throw new Fail(`${verb} needs a ref or a name`);
    for (let tries = 0; ; tries++) {
      try { const at = aim(cap, tab, rest ? a._[0] : a._.join(' '), verb); tab.begin(); return at; }
      catch (e) {
        if (!(e instanceof NotThere) || tries >= 3) throw e;
        await sleep(250);
        await tab.identify();
        cap = await capture(tab);
      }
    }
  };
  const named = (id) => { const n = cap?.nodes.find((x) => x.backendDOMNodeId === id && (!x.ignored || cap.pressable.has(x.nodeId))); const name = n ? nameOf(cap, n) : ''; return name ? ` ${quote(name, 50)}` : ''; };
  if (verb === 'click' || verb === 'hover') {
    const [id, ref] = await needRef();
    await mouse(tab, await point(tab, id, ref), verb === 'click');
    return `${verb === 'click' ? 'clicked' : 'hovering over'} ${ref}${named(id)}`;
  }
  if (verb === 'check' || verb === 'uncheck') {
    const [id, ref] = await needRef(), want = verb === 'check';
    const now = await tab.on(id, function () { return 'checked' in this ? this.checked : this.getAttribute?.('aria-checked') === 'true'; });
    if (now === want) return `${ref}${named(id)} was already ${want ? 'checked' : 'unchecked'}`;
    await mouse(tab, await point(tab, id, ref), true);
    return `${want ? 'checked' : 'unchecked'} ${ref}${named(id)}`;
  }
  if (verb === 'fill') {
    if (a._.length < 2) throw new Fail('fill needs a ref (or a name) and a text');
    const [id, ref] = await needRef(true);
    const text = a._.slice(1).join(' ');
    if (cap?.secret.has(id)) throw new Fail(`${ref} ${NOT_OURS}`);
    const kind = await tab.on(id, function () {
      if (this.tagName === 'SELECT') return 'select';
      if (this.disabled || this.readOnly) return 'locked';
      if (typeof this.focus !== 'function') return 'not a field';
      this.focus();
      if (typeof this.select === 'function') this.select();
      else if (this.isContentEditable) getSelection().selectAllChildren(this);
      else return 'not a field';
      return 'ok';
    });
    if (kind === 'select') throw new Fail(`${ref} is a list: chrome-pane select ${ref} "<option>"`);
    if (kind !== 'ok') throw new Fail(`${ref} cannot be filled: ${kind === 'locked' ? 'it is disabled or read-only' : 'it is not a text field'}`);
    if (text === '') await press(tab, { type: 'key', name: 'Backspace' });
    else await tab.send('Input.insertText', { text });
    return `filled ${ref}${named(id)}`;
  }
  if (verb === 'type') {
    if (!a._.length) throw new Fail('type needs a text');
    await notSecret(tab);
    await tab.send('Input.insertText', { text: a._.join(' ') });
    return 'typed into the focused field';
  }
  if (verb === 'press') {
    if (!a._.length) throw new Fail('press needs a key');
    const keys = a._.map(keyEvent);
    // Keys that write (a letter, a digit, a sign) are typing: Enter, Tab and the arrows are not.
    if (keys.some((ev) => [...ev.name].length === 1 && !ev.ctrl && !ev.meta)) await notSecret(tab);
    for (const ev of keys) await press(tab, ev);
    return `pressed ${a._.join(' ')}`;
  }
  if (verb === 'select') {
    if (a._.length < 2) throw new Fail('select needs a ref (or a name) and an option');
    const [id, ref] = await needRef(true);
    const r = await tab.on(id, function (want) {
      if (this.tagName !== 'SELECT') return { error: 'it is not a list (a custom one opens with click)' };
      const norm = (s) => String(s).trim().toLowerCase(), w = norm(want), options = [...this.options];
      const o = options.find((x) => norm(x.label) === w || norm(x.value) === w) ?? options.find((x) => norm(x.label).includes(w));
      if (!o) return { error: `it has no option ${JSON.stringify(want)}; it has: ${options.slice(0, 12).map((x) => x.label.trim()).join(', ')}` };
      this.value = o.value;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return { label: o.label.trim() };
    }, a._.slice(1).join(' '));
    if (r.error) throw new Fail(`${ref}: ${r.error}`);
    return `selected ${JSON.stringify(r.label)} in ${ref}${named(id)}`;
  }
  if (verb === 'scroll') {
    const how = a._[0] ?? 'down';
    if (['down', 'up', 'top', 'bottom'].includes(how)) {
      await tab.run(function (how) {
        if (how === 'top') scrollTo(0, 0);
        else if (how === 'bottom') scrollTo(0, document.documentElement.scrollHeight);
        else scrollBy({ top: (how === 'down' ? 1 : -1) * Math.round(innerHeight * 0.85), behavior: 'instant' });
      }, how);
      return `scrolled ${how === 'top' || how === 'bottom' ? `to the ${how}` : how}`;
    }
    const id = tab.ref(how);
    await tab.on(id, function () { this.scrollIntoView({ block: 'center', behavior: 'instant' }); });
    return `scrolled to ${how}`;
  }
  if (verb === 'wait') {
    if (a.timeout !== undefined && !(Number(a.timeout) > 0)) throw new Fail('--timeout takes seconds: a number above 0 (60 at most)');
    const limit = Math.min(60, Math.max(0.1, Number(a.timeout) || 10)) * 1000, start = Date.now();
    // A page that stops at a dialog, or a tab that closes, ends the wait: it is not "not yet".
    const no = (e) => { if (e instanceof DialogOpen || e.code === 2) throw e; return false; };
    const want = a.gone ? { gone: a.gone } : a.url ? { url: a.url } : a.idle ? { idle: true } : a._[0] ? { text: a._.join(' ') } : null;
    if (!want) throw new Fail('wait needs something to wait for: wait <text>, --gone <text>, --url <part of the address> or --idle');
    for (;;) {
      let met = false;
      if (want.idle) met = !tab.loading && (await tab.run(function () { return document.readyState === 'complete'; }).catch(no));
      else met = await tab.run(function (w) {
        if (w.url) return location.href.includes(w.url);
        const has = (document.body?.innerText ?? '').toLowerCase().includes(String(w.text ?? w.gone).toLowerCase());
        return w.gone ? !has : has;
      }, want).catch(no);
      const what = want.idle ? 'the page is loaded' : want.url ? `the address has ${JSON.stringify(want.url)}` : want.gone ? `${JSON.stringify(want.gone)} is gone` : `${JSON.stringify(want.text)} is on the page`;
      if (met) return `${what} (after ${((Date.now() - start) / 1000).toFixed(1)} s)`;
      if (Date.now() - start > limit) throw new Fail(`waited ${limit / 1000} s and it is not so: ${what}`);
      await sleep(200);
    }
  }
  throw new Fail(`${verb} is not an action`);
}

/**
 * In the page: watches it for changes, and says how long ago the last one was, in ms. `how`:
 * 'start' before an action (nothing has changed yet), 'stop' to end the watch. A watch that
 * begins when asked knows nothing of the moment before: it says 0.
 */
function stillFor(how) {
  let w = globalThis.chromePaneWatch;
  if (how === 'stop') { w?.seen.disconnect(); delete globalThis.chromePaneWatch; return 0; }
  if (how === 'start' && w) w.at = -1e9;
  if (!w) {
    w = globalThis.chromePaneWatch = { at: how === 'start' ? -1e9 : performance.now(), seen: new MutationObserver(() => { w.at = performance.now(); }) };
    w.seen.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  // What is on its way in or out (a dialog that fades, a menu that slides) is a change still going
  // on. Not what only changes a colour, nor what never ends (a spinner) or lasts (a progress bar).
  if (how !== 'start') for (const a of document.getAnimations?.() ?? []) {
    const t = a.playState === 'running' && a.effect?.getComputedTiming?.();
    if (!t || !(t.endTime - (a.currentTime ?? 0) <= 1000)) continue;
    if (!/color|shadow|outline|fill|stroke|decoration/.test(a.transitionProperty ?? '')) return 0;
  }
  return performance.now() - w.at;
}

/**
 * Lets the page take the action in, for as long as the page needs and no longer: the load it
 * began, the answers it asked the network for (a search, a save, a report), and the changes
 * those make to it. `least`: the shortest wait, for what a page does a moment later by itself.
 * Resolves to true when it gave up with answers still to come.
 */
async function settle(tab, o = {}) {
  const least = o.least ?? 120, still = o.still ?? 80, load = o.load ?? 15000, answers = o.answers ?? 8000, start = Date.now();
  const pending = () => tab.pending(o.others);
  // `watched`: the watch for changes is on in the document the tab shows now (a new page needs a new one).
  let moving = 0, watched = !tab.loading && o.watched;
  for (;;) {
    if (tab.dialog || tab.gone) return false;
    const since = Date.now() - start;
    if (tab.loading) { watched = false; if (since > load) return false; await sleep(20); continue; }
    if (!watched) { watched = true; await tab.run(stillFor, 'ask').catch(() => {}); continue; }
    if (pending()) { if (since > answers) return true; await sleep(20); continue; }
    const wait = Math.max(least - since, still - (Date.now() - tab.stir));
    if (wait > 0) { await sleep(Math.min(wait, 40)); continue; }
    // A page that never rests (a clock, a ticker) is not waited for.
    if (moving > 1500) return false;
    let rest;
    try { rest = await tab.run(stillFor, 'ask'); } catch (e) { if (e instanceof DialogOpen || e.code === 2) continue; return false; }
    if (tab.loading || pending()) continue;
    if (rest >= still) return false;
    moving += still - rest;
    await sleep(Math.max(10, still - rest));
  }
}

/**
 * What an action changed: the page's controls and messages before against after (~ changed,
 * - gone, + new). The whole page when it is a new one.
 */
async function report(tab, before, opts = {}) {
  if (tab.dialog) return dialogLine(tab.dialog);
  await tab.identify();
  const cap = await capture(tab);
  if (tab.turned || opts.whole || !before) return render(cap, tab, {});
  const after = controlLines(cap, tab);
  const changed = [], gone = [], come = [];
  for (const [ref, line] of before.controls) {
    const now = after.get(ref);
    if (now === undefined) gone.push(`- ${line}`); else if (now !== line) changed.push(`~ ${now}`);
  }
  for (const [ref, line] of after) if (!before.controls.has(ref)) come.push(`+ ${line}`);
  // The words the page did not have before: what it answered with, where it gave that no role.
  const said = [...after.texts].filter((t) => !before.controls.texts.has(t));
  const words = said.slice(0, 6).map((t) => `+ text ${quote(t, 200)}`);
  if (said.length > 6) words.push(`… ${said.length - 6} more new pieces of text (chrome-pane read shows the text)`);
  const moved = before.view.sy !== cap.view.sy ? [`view now at ${Math.round(cap.view.sy)} of ${cap.view.dh} px`] : [];
  const urlNow = before.view.url !== cap.view.url ? [`address now ${cap.view.url.slice(0, 120)}`] : [];
  const lines = [...urlNow, ...moved, ...changed, ...gone, ...come];
  if (!lines.length && !words.length) return 'nothing the page shows changed';
  return [...(lines.length > 40 ? [...lines.slice(0, 40), `… ${lines.length - 40} more changes (chrome-pane snapshot shows the page as it is)`] : lines), ...words].join('\n');
}

// ---------------------------------------------------------------- screenshots

function jpegSize(buf) {
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * A picture of what the pane shows, into a file. It is one frame of Chrome's own stream of the
 * tab, not a screenshot: while Chrome takes a screenshot of a page whose size a viewer set, the
 * person's clicks get lost.
 */
async function shot(tab, o, hidden = false) {
  const ext = o.png ? '.png' : '.jpg';
  // Its own folder, the person's alone. Elsewhere only a new picture file: never over a file
  // there is, and never a name that some program reads as anything but a picture.
  const dir = path.join(stateDir(), 'shots');
  let file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}${ext}`);
  if (o.out) {
    file = path.resolve(o.out);
    const given = path.extname(file).toLowerCase();
    if (given !== ext && !(ext === '.jpg' && given === '.jpeg')) throw new Fail(`--out takes a ${ext} file${o.png ? '' : ' (or --png and a .png file)'}`);
    if (fs.existsSync(file)) throw new Fail(`${file} exists: shot never writes over a file`);
  } else {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Yesterday's pictures have been looked at.
    for (const name of fs.readdirSync(dir)) {
      const old = path.join(dir, name);
      try { if (Date.now() - fs.statSync(old).mtimeMs > 86400000) fs.unlinkSync(old); } catch {}
    }
  }
  const view = await tab.run(function () { return { vw: innerWidth, vh: innerHeight, x: visualViewport.pageLeft, y: visualViewport.pageTop }; });
  const scale = Math.min(2, Math.max(0.1, Number(o.scale) || 1)), format = o.png ? 'png' : 'jpeg';
  // A hidden tab is behind the others in Chrome, which draws no frames of it: a screenshot then.
  // (With no pane, there are no clicks of the person's for a screenshot to lose.)
  const frame = hidden ? tab.send('Page.captureScreenshot', { format, quality: 70, clip: { x: view.x, y: view.y, width: view.vw, height: view.vh, scale } }, 10000) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => { tab.cdp.off('event', on); reject(new Fail('Chrome sent no picture: it is not drawing this tab (it may be behind another one in Chrome)')); }, 4000);
    const on = (method, p, sid) => { if (sid === tab.sid && method === 'Page.screencastFrame') { clearTimeout(timer); tab.cdp.off('event', on); resolve(p); } };
    tab.cdp.on('event', on);
  });
  if (!hidden) await tab.send('Page.startScreencast', { format, quality: 70, maxWidth: Math.round(view.vw * scale), maxHeight: Math.round(view.vh * scale), everyNthFrame: 1 });
  let p;
  try { p = await frame; } finally { if (!hidden) await tab.send('Page.stopScreencast').catch(() => {}); }
  const buf = Buffer.from(p.data, 'base64');
  try { fs.writeFileSync(file, buf, { mode: 0o600, flag: 'wx' }); }
  catch (e) { throw new Fail(e.code === 'EEXIST' ? `${file} exists: shot never writes over a file` : `could not write ${file}: ${e.code === 'ENOENT' ? 'its folder does not exist' : e.message}`); }
  const size = o.png ? pngSize(p.data) : jpegSize(buf);
  const tokens = size ? Math.ceil(size.w / 28) * Math.ceil(size.h / 28) : null;
  return `${file}\n${size ? `${size.w}x${size.h} px, ` : ''}${Math.round(buf.length / 1024)} KB${tokens ? `, about ${tokens} tokens to look at` : ''}. Read the file to see it.`;
}

// ---------------------------------------------------------------- one command

/**
 * The viewers of the tab this runs in, the one that changed tab last first, and the multiplexer
 * that says which tab that is. Outside one (host: null) there is no "this tab": every viewer.
 */
function paneList(opts = {}) {
  // A pane the person sees comes before a hidden tab: what they look at is what an agent acts on.
  const panes = listPanes(opts).sort((a, b) => Boolean(a.hidden) - Boolean(b.hidden));
  const host = hostOf();
  if (host) try { return { host, panes: host.panes(panes, process.env) }; } catch {}
  return { host: null, panes };
}

/** The pane whose tab to act on: the one of this tab of Herdr, Rex or Tern, else the pane used last. */
const paneHere = (opts) => paneList(opts).panes[0] ?? null;

async function bridge(o) {
  if (!(await canConnect(o.socket || socketPath()))) throw new Fail(noPane(), 2);
  const cdp = await connect({ ...o, autostart: false });
  if (cdp.state !== 'ready') await Promise.race([cdp.ready(), sleep(1500)]).catch(() => {});
  if (cdp.state !== 'ready') { cdp.close(); throw new Fail('Chrome has not allowed the connection yet: the person must accept its “Allow remote debugging?” prompt, on the computer Chrome runs on.', 2); }
  return cdp;
}

/** Starts a hidden tab's holder (it starts the bridge too), at the address. Resolves to how to find it. */
function startHolder(url, o) {
  fs.mkdirSync(path.dirname(logPath()), { recursive: true, mode: 0o700 });
  const log = fs.openSync(logPath(), 'a');
  const args = [fileURLToPath(new URL('./chrome-pane.mjs', import.meta.url)), 'hold', url];
  if (o.socket) args.push('--socket', o.socket);
  if (o.userDataDir) args.push('--user-data-dir', o.userDataDir);
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
  fs.closeSync(log);
  return (list) => list.find((p) => p.pid === child.pid);
}

/**
 * Opens the pane (it starts the bridge and shows the address) and waits for it to say which tab
 * it shows. `hidden`, or with no multiplexer to open a pane in: a hidden tab instead.
 */
async function openPaneAt(url, o = {}) {
  // A pane that is there but shows no tab (its list of tabs, or it waits for Chrome's prompt)
  // is asked to open the address: never a second pane beside it.
  const { host, panes: [idle] } = paneList({ all: true });
  if (idle?.state === 'waiting') throw new Fail(ASK_ALLOW, 2);
  const hidden = !idle && (o.hidden || /^(1|true|yes)$/i.test(process.env.CHROME_PANE_HIDDEN ?? '') || !host);
  let match, opened = false;
  if (idle) {
    writeAsk(`pane-${idle.pid}`, { open: url });
    match = (list) => list.find((p) => p.pid === idle.pid);
  } else if (hidden) {
    match = startHolder(url, o);
    opened = true;
  } else {
    try {
      // A pane of this tab that has not said anything yet (it is starting) is waited for, too.
      match = host.starting(process.env);
      opened = !match;
      match ??= host.open([url], process.env).match;
    } catch (e) { throw new Fail(`${host.name} did not open the pane: ${oneLine(e.message)}`, 2); }
  }
  for (let i = 0; i < 150; i++) {
    await sleep(100);
    const pane = match(listPanes({ all: true }));
    if (pane?.targetId) return pane.targetId;
    // A hidden tab has no pane to show Chrome's prompt in: say so now. It opens once allowed.
    if (pane?.hidden && pane.state === 'waiting') throw new Fail(ASK_ALLOW, 2);
  }
  if (idle) writeAsk(`pane-${idle.pid}`, null);
  throw new Fail(`The ${hidden ? 'hidden tab' : 'pane'} ${opened ? 'opened' : 'is there'} but shows no page yet: Chrome may be asking the person to allow the connection. Try again once they have (it will not open a second one).`, 2);
}

/**
 * Quits the viewer of this tab's pane, as Ctrl+Q in it would: it gives the tab its own size back
 * and goes, and its multiplexer takes the pane away. The tab stays open in Chrome. With no pane
 * there is nothing to do, which is not a failure: the pane was closed all the same.
 */
async function closePane(out) {
  const pane = paneList({ all: true }).panes[0];
  if (!pane) { out('There is no Chrome pane here.'); return 0; }
  const hidden = Boolean(pane.hidden);
  if (pane.targetId) writeNote(pane.targetId, null);
  // ours, not only alive: a viewer that has quit may linger as a zombie until its parent reaps it.
  const alive = () => ours(pane.pid);
  if (alive()) process.kill(pane.pid, 'SIGTERM');
  for (let i = 0; i < 60 && alive(); i++) await sleep(50);
  if (alive()) throw new Fail(`the pane (pid ${pane.pid}) has not closed yet. The person can quit it with Ctrl+Q`);
  // A hidden tab's holder closes the tabs it opened: the person never saw them.
  out(hidden ? 'Closed the hidden tab.' : 'Closed the pane. The tab stays open in Chrome.');
  return 0;
}

/**
 * Shows the hidden tab to the person: a pane on it beside the agent's, which they can use (a
 * password to type, a purchase to confirm). Its holder steps aside once the pane shows the tab.
 * With no multiplexer to open a pane in, it says what the person can run.
 */
async function showPane(out) {
  const { host, panes: [pane] } = paneList();
  if (!pane) throw new Fail(noPane(), 2);
  if (!pane.hidden) { out('The pane beside you shows the tab already.'); return 0; }
  if (!host) {
    out(`There is no terminal of Herdr, Rex or Tern here to open a pane in. The person can see the tab and use it with, in a terminal: chrome-pane --tab ${pane.targetId}`);
    return 0;
  }
  let match;
  try { match = host.open(['--tab', pane.targetId], process.env).match; } catch (e) { throw new Fail(`${host.name} did not open the pane: ${oneLine(e.message)}`, 2); }
  for (let i = 0; i < 150; i++) {
    await sleep(100);
    if (match(listPanes())?.targetId === pane.targetId) { out(`The tab is in a pane of this ${host.name} tab now: the person can see it and use it.`); return 0; }
  }
  throw new Fail('The pane opened but does not show the tab yet: Chrome may be asking the person to allow the connection.', 2);
}

/** Runs one agent command. Resolves to its exit code; what it has to say goes to `out`. */
export async function runAgent(verb, argv, io = {}) {
  // What a command prints is mostly the page's own words: never its control codes.
  const say = io.out ?? ((s) => process.stdout.write(`${s}\n`));
  const out = (s) => say(clean(s));
  let cdp = null, tab = null;
  try {
    const o = parse(argv);
    if (verb === 'open') o.address = webAddress(o._[0]);
    const pane = paneHere();
    let targetId = pane?.targetId ?? null;
    let fresh = false;
    const note = (text) => writeNote(targetId, text);
    if (verb === 'done') { if (targetId) note(null); return 0; }
    if (verb === 'close') return await closePane(out);
    if (verb === 'show') return await showPane(out);
    if (verb === 'dialog') {
      const accept = o._[0] === 'accept';
      if (!accept && o._[0] !== 'dismiss') throw new Fail('dialog accept [text], or dialog dismiss');
      if (!targetId) throw new Fail(noPane(), 2);
      if (!pane.dialog) throw new Fail('the page shows no dialog');
      // The pane's viewer answers it: only a connection that saw the dialog open can.
      writeAsk(targetId, { dialog: { accept, ...(o._[1] !== undefined ? { text: o._.slice(1).join(' ') } : {}) } });
      let answered = false;
      for (let i = 0; i < 160 && !answered; i++) {
        await sleep(25);
        answered = !listPanes().find((p) => p.pid === pane.pid)?.dialog;
      }
      if (!answered) {
        writeAsk(targetId, null);
        throw new Fail('the pane did not answer the dialog. The person can, in the pane: Enter accepts, Esc dismisses');
      }
      out(`${accept ? 'accepted' : 'dismissed'} the dialog`);
      // What the page did with the answer: the outcome of the action that made it ask.
      const kept = readBefore(targetId);
      writeBefore(targetId, null);
      if (!kept || Date.now() - kept.at > 600000) return 0;
      try {
        cdp = await bridge(o);
        tab = await Tab.attach(cdp, targetId);
        await tab.track();
        tab.loading = await tab.run(function () { return document.readyState !== 'complete'; }).catch(() => false);
        await tab.run(stillFor, 'start').catch(() => {});
        await settle(tab, { least: 350, watched: true });
        if (!tab.dialog) await tab.run(stillFor, 'stop').catch(() => {});
        const controls = new Map(kept.controls);
        controls.texts = new Set(kept.texts);
        out(await report(tab, kept.loaderId === tab.loaderId ? { controls, view: kept.view } : null));
      } catch (e) { if (e instanceof DialogOpen) out(e.message); }
      return 0;
    }
    if (pane?.dialog) throw new DialogOpen(dialogLine(pane.dialog));
    if (!targetId) {
      if (verb !== 'open') {
        const gone = paneList({ all: true }).panes.find((p) => p.hidden && p.lost);
        throw new Fail(gone ? `${gone.lost} Run: chrome-pane open <url>` : noPane(), 2);
      }
      targetId = await openPaneAt(o.address, o);
      fresh = true;
    }
    cdp = await bridge(o);
    tab = await Tab.attach(cdp, targetId);

    if (verb === 'open' || verb === 'back' || verb === 'forward' || verb === 'reload') {
      note(verb === 'open' ? `open ${o.address}` : verb);
      await tab.track();
      if (verb === 'open' && !fresh) {
        tab.loading = true;
        const r = await tab.send('Page.navigate', { url: o.address }, 30000);
        // A jump inside the same document loads nothing; an address that fails says why.
        if (!r.loaderId || r.errorText) tab.loading = false;
        if (r.errorText) throw new Fail(`could not open ${o.address}: ${r.errorText}`);
      }
      else if (verb === 'reload') {
        // Chrome reloads the answer to a sent form by sending the form again, and asked through
        // this connection it does not ask the person first, as its own reload does.
        if (pane?.posted && !o.resend) throw new Fail('this page is the answer to a form that was sent: a reload sends the form again, be it a payment, an order or a message. Ask the person first. If they want it sent again: chrome-pane reload --resend');
        tab.loading = true;
        await tab.send('Page.reload');
      }
      else if (verb === 'back' || verb === 'forward') {
        const h = await tab.send('Page.getNavigationHistory');
        const entry = h.entries[h.currentIndex + (verb === 'back' ? -1 : 1)];
        if (!entry) throw new Fail(`there is no page to go ${verb} to`);
        tab.loading = true;
        await tab.send('Page.navigateToHistoryEntry', { entryId: entry.id });
        // A page kept for the back button comes back without loading.
        setTimeout(() => { tab.loading = false; }, 1500).unref();
      } else if (fresh) {
        // The pane's viewer opened the tab at the address: a new tab is blank until it gets there.
        for (let i = 0; i < 100 && o.address !== 'about:blank'; i++) {
          if ((await tab.run(function () { return location.href; }).catch(() => 'about:blank')) !== 'about:blank') break;
          await sleep(100);
        }
        tab.loading = await tab.run(function () { return document.readyState !== 'complete'; }).catch(() => true);
      }
      // What the page fetches from its own site to fill itself in is waited for, for a moment:
      // not what it keeps open, nor what other sites send it (ads, counters).
      await settle(tab, { load: 20000, answers: 3000, others: 0, least: 0 });
      out(await report(tab, null, { whole: true }));
      return 0;
    }

    if (verb === 'snapshot') {
      const cap = await capture(tab);
      out(render(cap, tab, { all: o.all, text: o.text, urls: o.urls, within: o.in ? tab.ref(o.in) : null }));
      return 0;
    }
    if (verb === 'find') {
      if (!o._.length) throw new Fail('find needs a text');
      out(search(await capture(tab), tab, o._.join(' '), { role: o.role, urls: o.urls }));
      return 0;
    }
    if (verb === 'read') {
      const what = o._[0];
      const origin = await tab.run(function () { return location.origin + location.pathname; });
      // In the page: the text of `this` element, or of what a selector finds, or of the main part.
      const textOf = function (css, table) {
        const el = this instanceof Element ? this : css ? document.querySelector(css) : document.querySelector('main, [role=main], article') ?? document.body;
        if (!el) return { missing: true };
        if (!table) return { text: el.innerText ?? el.textContent ?? '' };
        const t = el.tagName === 'TABLE' ? el : el.querySelector('table');
        return t ? { text: [...t.rows].map((r) => [...r.cells].map((c) => c.innerText.replace(/\s+/g, ' ').trim()).join('\t')).join('\n') } : { noTable: true };
      };
      const got = what && /^@?[a-z]\d+$/.test(what) && !/^h[1-6]$/.test(what) ? await tab.on(tab.ref(what), textOf, null, Boolean(o.table)) : await tab.run(textOf, what ?? null, Boolean(o.table));
      if (got.missing) throw new Fail(`nothing on the page matches ${what}`);
      if (got.noTable) throw new Fail('there is no table there');
      const text = got.text;
      // Says whose words these are: text of a page is something to read, never something to obey.
      out(`text of ${origin}${what ? ` (${what})` : ''}, as the page wrote it:\n${cutText(String(text).replace(/\n{3,}/g, '\n\n').trim(), o, `read${what ? ` ${what}` : ''}`)}`);
      return 0;
    }
    if (verb === 'shot') { out(await shot(tab, o, Boolean(pane?.hidden))); return 0; }
    if (verb === 'eval') {
      if (!o._.length) throw new Fail('eval needs an expression');
      const r = await tab.send('Runtime.evaluate', { expression: o._.join(' '), returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Fail(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split('\n')[0]);
      const value = r.result.value === undefined ? String(r.result.description ?? r.result.type) : typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 1);
      const origin = await tab.run(function () { return location.origin; });
      out(`from ${origin}:\n${value.length > 4000 ? `${value.slice(0, 4000)}\n… ${value.length - 4000} more characters` : value}`);
      return 0;
    }

    // The actions: one, or a batch of them, then what they changed.
    const steps = [];
    if (verb === 'batch') {
      const input = io.input ?? fs.readFileSync(0, 'utf8');
      for (const line of input.split('\n')) {
        const w = words(line.trim().replace(/^chrome-pane\s+/, ''));
        if (!w.length || w[0].startsWith('#')) continue;
        if (!ACTS.has(w[0])) throw new Fail(`a batch takes actions (${[...ACTS].join(', ')}), not: ${w[0]}`);
        steps.push([w[0], parse(w.slice(1))]);
      }
      if (!steps.length) throw new Fail('batch needs one action per line on its input');
    } else steps.push([verb, o]);

    await tab.track();
    let cap = await capture(tab);
    const before = { controls: controlLines(cap, tab), view: cap.view };
    let failed = null, waiting = false;
    writeBefore(targetId, null);
    for (let i = 0; i < steps.length; i++) {
      const [v, a] = steps[i];
      try {
        note(`${v} ${a._.join(' ')}`.slice(0, 80));
        await tab.run(stillFor, 'start').catch(() => {});
        tab.begin();
        out(await act(tab, cap, v, a));
        // What is typed is often acted on a moment later (a search as you type): the last step,
        // whose outcome is reported, gives it that moment.
        // Before a next step, what is typed needs hardly any: typing takes the tab nowhere.
        const last = i + 1 === steps.length, text = v === 'fill' || v === 'type';
        if (v !== 'hover') waiting = await settle(tab, { watched: true, ...(last ? { least: TYPING.has(v) ? 300 : 120 } : text ? { least: 40, still: 40 } : {}) });
        if (tab.dialog) { if (i + 1 < steps.length) out(`stopped: ${steps.length - i - 1} steps not done`); break; }
        if (i + 1 < steps.length) { await tab.identify(); cap = await capture(tab); }
      } catch (e) {
        // Not a failure: the action did what it does, and the page now asks something.
        if (e instanceof DialogOpen) { out(`${v} ${a._.join(' ')}: the page opened a dialog`); if (i + 1 < steps.length) out(`stopped: ${steps.length - i - 1} steps not done`); break; }
        if (steps.length === 1) { await tab.run(stillFor, 'stop').catch(() => {}); throw e; }
        failed = e;
        out(`failed at step ${i + 1} (${v} ${a._.join(' ')}): ${e.message}${i + 1 < steps.length ? `; ${steps.length - i - 1} steps not done` : ''}`);
        break;
      }
    }
    if (!tab.dialog) await tab.run(stillFor, 'stop').catch(() => {});
    // The page asks something: its answer to that is the outcome, told against what it showed before.
    if (tab.dialog && !tab.turned) writeBefore(targetId, { loaderId: tab.loaderId, controls: [...before.controls], texts: [...before.controls.texts], view: before.view });
    out(await report(tab, before, { whole: verb === 'scroll' && steps.length === 1 }));
    if (waiting && !tab.dialog) out('the page still waits for an answer to this: chrome-pane wait <text> waits for what it will show');
    // The page opened a tab of its own (a sign-in window, a link in a new tab) and the pane followed it.
    const now = paneHere();
    if (now?.targetId && now.targetId !== targetId) out('the pane now shows another tab, which the page opened: chrome-pane snapshot prints it');
    return failed ? 1 : 0;
  } catch (e) {
    if (e instanceof Stale && tab) {
      // The page is another one than the ref was given for: here is the one there is.
      let now = '';
      try { await tab.identify(); now = `\n${render(await capture(tab), tab, {})}`; } catch {}
      out(`stale: ${e.message}. The page now:${now}`);
      return 1;
    }
    out(`chrome-pane: ${e.message}`);
    return e instanceof Fail ? e.code : 1;
  } finally {
    cdp?.close();
  }
}
