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
import fs from 'node:fs';
import path from 'node:path';
import { canConnect } from './bridge.mjs';
import { connect } from './cdp.mjs';
import { hostOf } from './hosts.mjs';
import { keyCalls } from './keys.mjs';
import { listPanes, readDoc, writeAsk, writeDoc, writeNote } from './panes.mjs';
import { socketPath, stateDir } from './paths.mjs';
import { clean, oneLine, pngSize } from './util.mjs';

export const VERBS = new Set(['open', 'snapshot', 'find', 'read', 'click', 'hover', 'fill', 'type', 'press', 'select', 'check', 'uncheck',
  'scroll', 'wait', 'back', 'forward', 'reload', 'batch', 'shot', 'eval', 'dialog', 'done']);
const ACTS = new Set(['click', 'hover', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'scroll', 'wait']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LETTERS = 'efghijklmnopqrstuvwxyzabcd';

/** A failure the agent is told in a line. code 2: there is no pane or no bridge to talk to. */
class Fail extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}
/** A ref that is not of the page the tab shows now. */
class Stale extends Fail {}
/** The page stopped at an alert or a question: nothing in it answers until that is answered. */
class DialogOpen extends Fail {}

// Outside a multiplexer nothing can open a pane for the agent: a person shows a tab first.
const noPane = () => (hostOf()
  ? `No Chrome pane in this ${hostOf().name} tab. Run: chrome-pane open <url>`
  : 'No Chrome pane is open. Show a tab first: run chrome-pane in a terminal.');

// ---------------------------------------------------------------- arguments

const FLAGS = new Set(['all', 'text', 'urls', 'table', 'idle', 'png', 'json']);
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
    cdp.on('event', (method, p, sid2) => {
      // The tab closed, or Chrome let go of it: whatever waits for the page hears it at once.
      if ((method === 'Target.detachedFromTarget' && p.sessionId === sid) || (method === 'Target.targetDestroyed' && p.targetId === targetId)) {
        this.gone = true;
        for (const stop of [...this.waiting]) stop(new Fail('the tab was closed', 2));
      }
      if (sid2 !== sid) return;
      if (method === 'Page.frameStartedLoading' && p.frameId === this.frameId) this.loading = true;
      else if (method === 'Page.frameStoppedLoading' && p.frameId === this.frameId) this.loading = false;
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
    return changed;
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

const dialogLine = (d) => `The page shows a dialog (${d.type}): ${JSON.stringify(String(d.message).slice(0, 200))}. Answer it: chrome-pane dialog accept, or dialog dismiss`;

// ---------------------------------------------------------------- reading the page

const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'listbox', 'treeitem', 'textarea', 'DisclosureTriangle', 'PopUpButton', 'ColorWell', 'Date', 'DateTime', 'InputTime']);
const LANDMARK = new Set(['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'form', 'region', 'dialog', 'alertdialog', 'alert', 'status', 'table', 'grid', 'list', 'menu', 'menubar', 'tablist', 'toolbar', 'tree', 'article']);
const ALWAYS = new Set(['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'dialog', 'alertdialog', 'alert', 'status']);
const SKIP = new Set(['InlineTextBox', 'LineBreak', 'none', 'presentation']);
const VALUED = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'textarea']);

// A field for a password, a code sent to a phone or a card, by what it says of itself.
const SECRET = /(^|\s)(cc-|one-time-code|\S*password)/;
// The same by the field's name or id, for pages that say nothing in autocomplete (and for a
// password shown as text by a "show" button).
const SECRET_NAME = /passw|pwd|card.?num|cc.?(num|csc|cvc|cvv)|(^|[^a-z])(cvc|cvv|csc|otp)([^a-z]|$)|security.?code|one.?time/;
const NOT_OURS = 'holds a password, a code or a card: ask the person to type it in the pane';

const prop = (n, name) => n.properties?.find((p) => p.name === name)?.value?.value;
const quote = (s, max = 80) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return JSON.stringify(s.length > max ? `${s.slice(0, max - 1)}…` : s); };
const isControl = (n) => INTERACTIVE.has(n.role?.value) || (prop(n, 'focusable') === true && !['RootWebArea', 'generic', 'none', 'Iframe'].includes(n.role?.value));

/**
 * Reads the page: the accessibility tree (roles, names, states), each element's box (to know
 * what is in view) and which fields hold secrets.
 */
async function capture(tab) {
  const [{ nodes }, snap, view] = await Promise.all([
    tab.send('Accessibility.getFullAXTree'),
    tab.send('DOMSnapshot.captureSnapshot', { computedStyles: [] }),
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
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  return { nodes, byId, root: nodes.find((n) => !n.parentId) ?? nodes[0], box, secret, view };
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
  const name = n.name?.value?.trim();
  const url = o.urls && n.role?.value === 'link' ? prop(n, 'url') : null;
  return `${tab.letter}${n.backendDOMNodeId} ${n.role.value}${name ? ` ${quote(name)}` : ''}${states(cap, n)}${url ? ` → ${String(url).slice(0, 120)}` : ''}`;
};

// What the page tells the person: a message that came up, the state of something.
const SAYS = new Set(['alert', 'status', 'alertdialog']);

/** The text inside an element, as far as `max` characters. */
function textIn(cap, n, max = 160) {
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
  return text ? `${tab.letter}${n.backendDOMNodeId} ${n.role.value} ${quote(text, 160)}` : null;
};

/**
 * Every control of the page as its line, by ref, and every message the page shows: what two
 * moments of a page are compared by. All of the page, not only what is in view, so that a
 * scroll changes nothing; and without where the focus is, which every click moves.
 */
function controlLines(cap, tab) {
  const lines = new Map();
  const walk = (n, quiet) => {
    const role = n.role?.value;
    if (!n.ignored && !quiet && n.backendDOMNodeId) {
      if (isControl(n) && !SKIP.has(role)) { if (place(cap, n) !== 'none') lines.set(`${tab.letter}${n.backendDOMNodeId}`, controlLine(cap, tab, n).replace(' [focused]', '')); }
      else if (SAYS.has(role)) { const line = saysLine(cap, tab, n); if (line) lines.set(`${tab.letter}${n.backendDOMNodeId}`, line); }
    }
    // The options of a closed list say again what the list's own line says.
    const closed = quiet || (role === 'combobox' && prop(n, 'expanded') !== true);
    for (const c of kids(cap, n)) walk(c, closed);
  };
  walk(cap.root, false);
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
    const role = n.role?.value;
    if (n.ignored || SKIP.has(role)) return kids(cap, n).flatMap((k) => build(k, held));
    if (role === 'StaticText') {
      if (!o.text) return [];
      const t = n.name?.value?.trim(), where = place(cap, cap.byId.get(n.parentId) ?? n);
      return t && (all || where === 'in' || where === null) ? [{ line: quote(t, 160), kids: [], kind: 'text' }] : [];
    }
    const control = isControl(n) && n.backendDOMNodeId;
    // The options of a closed list have no box: they are where their list is.
    const where = control ? place(cap, n) ?? held : null;
    const children = kids(cap, n).flatMap((k) => build(k, control ? where : held));
    const name = n.name?.value?.trim();
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
    if (SAYS.has(role) && !children.length && !o.text) {
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

/** The elements whose name, value or text has `text`: up to 20, each with where it is. */
function search(cap, tab, text, o = {}) {
  const want = text.toLowerCase(), hits = new Map();
  const whereWord = { in: 'in view', above: '↑ above', below: '↓ below', aside: 'out of view, to the side', none: 'hidden' };
  for (const n of cap.nodes) {
    if (n.ignored) continue;
    let target = n;
    // A piece of text is found through the element that holds it.
    if (n.role?.value === 'StaticText') { target = cap.byId.get(n.parentId); while (target && (target.ignored || !target.backendDOMNodeId)) target = cap.byId.get(target.parentId); }
    if (!target?.backendDOMNodeId || SKIP.has(target.role?.value) || target.role?.value === 'RootWebArea') continue;
    if (o.role && target.role?.value !== o.role) continue;
    const hay = `${n.name?.value ?? ''} ${cap.secret.has(n.backendDOMNodeId) ? '' : n.value?.value ?? ''}`.toLowerCase();
    if (!hay.includes(want)) continue;
    const where = place(cap, target);
    if (where === 'none' || hits.has(target.backendDOMNodeId)) continue;
    const control = isControl(target);
    const line = control ? controlLine(cap, tab, target, o) : `${tab.letter}${target.backendDOMNodeId} ${target.role?.value ?? 'text'} ${quote(target.name?.value || n.name?.value, 100)}`;
    hits.set(target.backendDOMNodeId, { line: `${line}  (${whereWord[where] ?? 'in view'})`, control, exact: (target.name?.value ?? '').trim().toLowerCase() === want });
  }
  // Controls first, and among them the ones named exactly so.
  const found = [...hits.values()].sort((a, b) => (b.control - a.control) || (b.exact - a.exact));
  const lines = found.slice(0, 20).map((h) => h.line);
  if (found.length > 20) lines.push(`… ${found.length - 20} more (a longer text, or --role <role>, narrows it)`);
  return lines.length ? lines.join('\n') : `nothing on the page has ${JSON.stringify(text)}${o.role ? ` with the role ${o.role}` : ''}`;
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
  const needRef = () => { if (!a._[0]) throw new Fail(`${verb} needs a ref`); return [tab.ref(a._[0]), a._[0].replace(/^@/, '')]; };
  const named = (id) => { const n = cap?.nodes.find((x) => x.backendDOMNodeId === id && !x.ignored); return n?.name?.value ? ` ${quote(n.name.value, 50)}` : ''; };
  if (verb === 'click' || verb === 'hover') {
    const [id, ref] = needRef();
    await mouse(tab, await point(tab, id, ref), verb === 'click');
    return `${verb === 'click' ? 'clicked' : 'hovering over'} ${ref}${named(id)}`;
  }
  if (verb === 'check' || verb === 'uncheck') {
    const [id, ref] = needRef(), want = verb === 'check';
    const now = await tab.on(id, function () { return 'checked' in this ? this.checked : this.getAttribute?.('aria-checked') === 'true'; });
    if (now === want) return `${ref}${named(id)} was already ${want ? 'checked' : 'unchecked'}`;
    await mouse(tab, await point(tab, id, ref), true);
    return `${want ? 'checked' : 'unchecked'} ${ref}${named(id)}`;
  }
  if (verb === 'fill') {
    const [id, ref] = needRef();
    if (a._.length < 2) throw new Fail('fill needs a ref and a text');
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
    const [id, ref] = needRef();
    if (a._.length < 2) throw new Fail('select needs a ref and an option');
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

/** Lets the page take the action in: a moment, and the end of a load if one began. */
async function settle(tab, ms = 15000) {
  await sleep(150);
  const start = Date.now();
  while (tab.loading && !tab.dialog && Date.now() - start < ms) await sleep(100);
  if (!tab.dialog) await sleep(200);
}

/**
 * What an action changed: the page's controls and messages before against after (~ changed,
 * - gone, + new). The whole page when it is a new one.
 */
async function report(tab, before, opts = {}) {
  if (tab.dialog) return dialogLine(tab.dialog);
  const newDoc = await tab.identify();
  const cap = await capture(tab);
  if (newDoc || opts.whole || !before) return render(cap, tab, {});
  const after = controlLines(cap, tab);
  const changed = [], gone = [], come = [];
  for (const [ref, line] of before.controls) {
    const now = after.get(ref);
    if (now === undefined) gone.push(`- ${line}`); else if (now !== line) changed.push(`~ ${now}`);
  }
  for (const [ref, line] of after) if (!before.controls.has(ref)) come.push(`+ ${line}`);
  const moved = before.view.sy !== cap.view.sy ? [`view now at ${Math.round(cap.view.sy)} of ${cap.view.dh} px`] : [];
  const urlNow = before.view.url !== cap.view.url ? [`address now ${cap.view.url.slice(0, 120)}`] : [];
  const lines = [...urlNow, ...moved, ...changed, ...gone, ...come];
  if (!lines.length) return 'no control or message of the page changed (read, or snapshot --text, shows its text)';
  return lines.length > 40 ? [...lines.slice(0, 40), `… ${lines.length - 40} more changes (chrome-pane snapshot shows the page as it is)`].join('\n') : lines.join('\n');
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
async function shot(tab, o) {
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
  const view = await tab.run(function () { return { vw: innerWidth, vh: innerHeight }; });
  const scale = Math.min(2, Math.max(0.1, Number(o.scale) || 1)), format = o.png ? 'png' : 'jpeg';
  const frame = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { tab.cdp.off('event', on); reject(new Fail('Chrome sent no picture: it is not drawing this tab (it may be behind another one in Chrome)')); }, 4000);
    const on = (method, p, sid) => { if (sid === tab.sid && method === 'Page.screencastFrame') { clearTimeout(timer); tab.cdp.off('event', on); resolve(p); } };
    tab.cdp.on('event', on);
  });
  await tab.send('Page.startScreencast', { format, quality: 70, maxWidth: Math.round(view.vw * scale), maxHeight: Math.round(view.vh * scale), everyNthFrame: 1 });
  let p;
  try { p = await frame; } finally { await tab.send('Page.stopScreencast').catch(() => {}); }
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
  const panes = listPanes(opts);
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

/** Opens the pane (it starts the bridge and shows the address) and waits for it to say which tab it shows. */
async function openPaneAt(url) {
  // A pane that is there but shows no tab (its list of tabs, or it waits for Chrome's prompt)
  // is asked to open the address: never a second pane beside it.
  const { host, panes: [idle] } = paneList({ all: true });
  if (!idle && !host) throw new Fail('There is no Chrome pane, and this terminal is not one of Herdr, Rex or Tern to open one in. Run chrome-pane in a terminal first.', 2);
  let match, opened = false;
  if (idle) {
    writeAsk(`pane-${idle.pid}`, { open: url });
    match = (list) => list.find((p) => p.pid === idle.pid);
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
    const pane = match(listPanes());
    if (pane) return pane.targetId;
  }
  if (idle) writeAsk(`pane-${idle.pid}`, null);
  throw new Fail(`The pane ${opened ? 'opened' : 'is there'} but shows no tab yet: Chrome may be asking the person to allow the connection. Try again once they have (it will not open a second pane).`, 2);
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
    if (verb === 'dialog') {
      const accept = o._[0] === 'accept';
      if (!accept && o._[0] !== 'dismiss') throw new Fail('dialog accept [text], or dialog dismiss');
      if (!targetId) throw new Fail(noPane(), 2);
      if (!pane.dialog) throw new Fail('the page shows no dialog');
      // The pane's viewer answers it: only a connection that saw the dialog open can.
      writeAsk(targetId, { dialog: { accept, ...(o._[1] !== undefined ? { text: o._.slice(1).join(' ') } : {}) } });
      for (let i = 0; i < 40; i++) {
        await sleep(100);
        if (!listPanes().find((p) => p.pid === pane.pid)?.dialog) { out(`${accept ? 'accepted' : 'dismissed'} the dialog`); return 0; }
      }
      writeAsk(targetId, null);
      throw new Fail('the pane did not answer the dialog. The person can, in the pane: Enter accepts, Esc dismisses');
    }
    if (pane?.dialog) throw new DialogOpen(dialogLine(pane.dialog));
    if (!targetId) {
      if (verb !== 'open') throw new Fail(noPane(), 2);
      targetId = await openPaneAt(o.address);
      fresh = true;
    }
    cdp = await bridge(o);
    tab = await Tab.attach(cdp, targetId);

    if (verb === 'open' || verb === 'back' || verb === 'forward' || verb === 'reload') {
      note(verb === 'open' ? `open ${o.address}` : verb);
      if (verb === 'open' && !fresh) {
        tab.loading = true;
        const r = await tab.send('Page.navigate', { url: o.address }, 30000);
        // A jump inside the same document loads nothing; an address that fails says why.
        if (!r.loaderId || r.errorText) tab.loading = false;
        if (r.errorText) throw new Fail(`could not open ${o.address}: ${r.errorText}`);
      }
      else if (verb === 'reload') { tab.loading = true; await tab.send('Page.reload'); }
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
      await settle(tab, 20000);
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
    if (verb === 'shot') { out(await shot(tab, o)); return 0; }
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

    let cap = await capture(tab);
    const before = { controls: controlLines(cap, tab), view: cap.view };
    let failed = null;
    for (let i = 0; i < steps.length; i++) {
      const [v, a] = steps[i];
      try {
        note(`${v} ${a._.join(' ')}`.slice(0, 80));
        out(await act(tab, cap, v, a));
        if (v !== 'hover') await settle(tab);
        if (tab.dialog) { if (i + 1 < steps.length) out(`stopped: ${steps.length - i - 1} steps not done`); break; }
        if (i + 1 < steps.length) { if (await tab.identify()) cap = null; cap = await capture(tab); }
      } catch (e) {
        // Not a failure: the action did what it does, and the page now asks something.
        if (e instanceof DialogOpen) { out(`${v} ${a._.join(' ')}: the page opened a dialog`); if (i + 1 < steps.length) out(`stopped: ${steps.length - i - 1} steps not done`); break; }
        if (steps.length === 1) throw e;
        failed = e;
        out(`failed at step ${i + 1} (${v} ${a._.join(' ')}): ${e.message}${i + 1 < steps.length ? `; ${steps.length - i - 1} steps not done` : ''}`);
        break;
      }
    }
    out(await report(tab, before, { whole: verb === 'scroll' && steps.length === 1 }));
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
