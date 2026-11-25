// The viewer's bar: what it says, where its buttons are, and how it is typed in.
//
// Pure, so that it can be tested without a terminal: barParts() turns what the viewer knows
// into the pieces of one line, each with a look and, for a button, what a click on it does.
// The same pieces are painted (paint) and hit (actAt), so a button is always where it is drawn.
// A multiplexer that draws controls of its own (Herdr's pane header) is given the same state
// and sends the same actions back: see Viewer.act.
import { oneLine, shortAddress, width } from './util.mjs';

const seg = (text, style = 'bar', act = null) => ({ text, style, act });
const widthOf = (segs) => segs.reduce((n, s) => n + width(s.text), 0);

/** What a button does, said in the address field while the mouse is on it. */
export const TIPS = {
  back: 'Back  ·  Alt+←',
  forward: 'Forward  ·  Alt+→',
  reload: 'Reload  ·  Ctrl+R',
  stop: 'Stop loading',
  tabs: 'Chrome’s tabs  ·  Ctrl+T',
};

/** `s` cut to at most `cols` cells; a cut ends in "…". */
export function cut(s, cols) {
  s = oneLine(s);
  if (cols <= 0) return '';
  if (width(s) <= cols) return s;
  let out = '', n = 0;
  for (const ch of s) {
    const w = width(ch);
    if (n + w > cols - 1) break;
    out += ch; n += w;
  }
  return out + '…';
}

/** The pieces cut to `room` cells, and padded to exactly that with `style`. */
function fill(segs, room, style) {
  const out = [];
  let left = room;
  for (const s of segs) {
    if (left <= 0) break;
    const w = width(s.text);
    if (w <= left) { out.push(s); left -= w; continue; }
    const text = cut(s.text, left);
    out.push({ ...s, text });
    left -= width(text);
    break;
  }
  if (left > 0) out.push(seg(' '.repeat(left), style));
  return out;
}

/** An address in pieces: the site stands out, what is around it steps back. */
function addressSegs(url) {
  const a = oneLine(shortAddress(url));
  const m = /^([a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)(.*)$/i.exec(a);
  if (!m || !m[2] || /^(about|data|blob|chrome|view-source|javascript):/i.test(a)) return a ? [seg(a, 'strong', 'address')] : [];
  return [m[1] && seg(m[1], 'dim', 'address'), seg(m[2], 'strong', 'address'), m[3] && seg(m[3], 'dim', 'address')].filter(Boolean);
}

/** The address field while it is typed in: the caret stays in view. */
function editField(e, room) {
  const inner = Math.max(1, room - 2);
  const chars = [...e.text];
  if (!chars.length) return fill([seg(' ', 'field'), seg(' ', 'cursor'), seg('Search, or type an address', 'dim')], room, 'field');
  if (e.all) return fill([seg(' ', 'field'), seg(cut(e.text, inner), 'sel')], room, 'field');
  const cur = Math.min(e.cur, chars.length);
  // The first character shown: far enough along that the caret, and a cell after it, fit.
  let start = 0;
  while (start < cur && width(chars.slice(start, cur).join('')) + 1 > inner) start++;
  const before = chars.slice(start, cur).join('');
  let after = '', n = width(before) + 1;
  for (const ch of chars.slice(cur + 1)) { if (n + width(ch) > inner) break; after += ch; n += width(ch); }
  const at = chars[cur] ?? ' ';
  return fill([seg(' ', 'field'), seg(before, 'edit'), seg(width(at) ? at : ' ', 'cursor'), seg(after, 'edit')], room, 'field');
}

/**
 * The bar as pieces that add up to exactly `cols` cells. `s` is what the viewer knows:
 * { mode, url, title, loading, back, fwd, tabs, agent, dialog, resend, hidden, notice, closing,
 *   edit: { text, cur, all } | null, hot } — hot being the button under the mouse.
 */
export function barParts(s, cols) {
  if (cols <= 0) return [];
  const button = (label, act) => seg(` ${label} `, 'btn2', act);
  // left and right keep their size; the middle takes what is left. A group on the right, and
  // those after it, go when the middle would be left with less than the group's `need` cells.
  let left = [], mid, groups = [];
  const need = 16;
  const says = (text, style = 'bar') => Object.assign((room) => fill([seg(` ${text}`, style)], room, 'bar'), { w: width(text) + 2 });
  if (s.edit) {
    left = [seg(' ')];
    mid = (room) => editField(s.edit, room);
    groups = [[seg(' ')], [seg(' Enter go ', 'hint', 'edit-go'), seg(' Esc cancel ', 'hint', 'edit-cancel')]];
    groups[1].need = 30;
  } else if (s.dialog) {
    mid = says(`${s.dialog.type}: ${s.dialog.message}`);
    groups = [[button('OK', 'dialog-ok'), seg(' '), ...(s.dialog.type === 'alert' ? [] : [button('Cancel', 'dialog-cancel'), seg(' ')])], [seg('Enter · Esc ', 'hint')]];
  } else if (s.mode === 'tabs' && s.closing) {
    mid = says(`Close “${cut(s.closing, 40)}” in Chrome?`);
    groups = [[button('Close it', 'close-yes'), seg(' '), button('Keep it', 'close-no'), seg(' ')], [seg('x again · any other key ', 'hint')]];
  } else if (s.mode === 'tabs') {
    mid = says('Chrome tabs', 'title');
    groups = [[seg(' Esc back ', 'hint', 'page')], [seg(' n new tab ', 'hint', 'newtab')], [seg(' q quit ', 'hint')], [seg(' ↑↓ move · Enter show · x close tab ', 'hint')]];
  } else if (s.mode === 'page' && s.resend) {
    mid = says('This page answers a form you sent: a reload sends the form again.');
    groups = [[button('Send it again', 'resend-yes'), seg(' '), button('Leave it', 'resend-no'), seg(' ')], [seg('Ctrl+R again · any other key ', 'hint')]];
  } else if (s.mode === 'page' && s.notice) {
    mid = says(s.notice);
  } else if (s.mode === 'page' && s.hidden) {
    mid = says('Chrome is not drawing this tab: it is behind another one.');
    groups = [[button('Bring it forward', 'front'), seg(' ')], [seg('or press a key ', 'hint')]];
  } else if (s.mode === 'page') {
    left = [seg(' ‹ ', s.back ? 'btn' : 'off', s.back ? 'back' : null), seg(' › ', s.fwd ? 'btn' : 'off', s.fwd ? 'forward' : null),
      s.loading ? seg(' ✕ ', 'btn', 'stop') : seg(' ↻ ', 'btn', 'reload'), seg(' ')];
    const page = addressSegs(s.url);
    const tip = TIPS[s.hot], sep = seg('  ·  ', 'dim', 'address');
    mid = (room) => {
      const inner = Math.max(0, room - 2);
      let segs;
      if (s.agent) {
        segs = [seg(`● Agent: ${s.agent}`, 'agent', 'address')];
        const about = s.title ? [seg(oneLine(s.title), 'dim', 'address')] : page.map((p) => ({ ...p, style: 'dim' }));
        if (inner - widthOf(segs) >= 15) segs.push(sep, ...about);
      } else {
        // The address first and whole while it fits, since it says where you are; the title
        // (or what the button under the mouse does) only in the room that is left.
        segs = page.length ? page : [seg(oneLine(s.title || ''), 'strong', 'address')];
        const more = tip ?? (page.length ? oneLine(s.title || '') : '');
        if (more && inner - widthOf(segs) - width(sep.text) >= 8) segs = [...segs, sep, seg(more, tip ? 'strong' : 'dim', 'address')];
      }
      return [seg(' ', 'field', 'address'), ...fill(segs, inner, 'field').map((p) => ({ ...p, act: 'address' })), seg(' ', 'field', 'address')];
    };
    const tabs = s.tabs > 0 ? `${s.tabs} tab${s.tabs === 1 ? '' : 's'}` : 'tabs';
    // The keys go first, well before the page's address is cut.
    groups = [[seg(' ')], [seg(` ${tabs} `, 'btn', 'tabs')], [seg(' ^L address · ^T tabs · ^Q quit ', 'hint')]];
    groups[1].need = 24;
    groups[2].need = 60;
  } else {
    mid = says('Chrome', 'title');
  }
  // What is said is not cut to make room for the keys: the buttons beside it already say them.
  if (mid.w) groups.slice(1).forEach((g) => { g.need ??= Math.max(need, mid.w); });
  const right = [];
  for (const g of groups) {
    if (cols - widthOf(left) - widthOf(right) - widthOf(g) < (g.need ?? need)) break;
    right.push(...g);
  }
  let parts = [...left, ...mid(Math.max(0, cols - widthOf(left) - widthOf(right))), ...right].filter((p) => p.text);
  // A pane narrower than its buttons: what fits of them.
  if (widthOf(parts) !== cols) parts = fill(parts, cols, 'bar');
  return parts;
}

/** What a click on that column (zero-based) of the bar does, or null. */
export function actAt(parts, col) {
  let at = 0;
  for (const p of parts) {
    at += width(p.text);
    if (col < at) return p.act;
  }
  return null;
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const on = (fg, bg) => `38;2;${fg.join(';')};48;2;${bg.join(';')}`;

/**
 * How each piece looks, as the numbers of an SGR sequence. With the terminal's own colours
 * (`fg` and `bg`, [r, g, b] each), the bar is a shade off the background, as a toolbar is,
 * and the field a shade the other way. Without them, the reverse video every terminal has.
 */
export function looks(fg, bg) {
  if (!fg || !bg) {
    return { bar: '7', title: '7;1', btn: '7', off: '7;2', hint: '7', hot: '7;4', btn2: '0;1', agent: '7;1',
      field: '7', strong: '7', dim: '7', edit: '7', sel: '0', cursor: '0' };
  }
  const bar = mix(bg, fg, 0.12), field = mix(bg, fg, 0.035), faint = mix(fg, bg, 0.5);
  return {
    bar: on(mix(fg, bg, 0.12), bar), title: `1;${on(fg, bar)}`, btn: on(fg, bar), off: on(mix(fg, bg, 0.7), bar), hint: on(faint, bar),
    hot: on(fg, mix(bg, fg, 0.3)), btn2: on(fg, mix(bg, fg, 0.28)), 
    field: on(faint, field), agent: `33;48;2;${field.join(';')}`, strong: on(fg, field), dim: on(faint, field), edit: on(fg, field), sel: on(fg, mix(bg, fg, 0.32)), cursor: on(bg, fg),
  };
}

const PRESSABLE = new Set(['btn', 'btn2', 'hint']);

/** The pieces as what is written to the terminal. `hot`: the action of the button under the mouse. */
export function paint(parts, look, hot = null) {
  let s = '';
  for (const p of parts) s += `\x1b[0;${look[hot && p.act === hot && PRESSABLE.has(p.style) ? 'hot' : p.style] ?? look.bar}m${p.text}`;
  return `${s}\x1b[0m`;
}

// ---------------------------------------------------------------- typing an address

/** An address being typed: its text, where the caret is (in characters), and whether all of it is selected. */
export const editOf = (text = '') => ({ text, cur: [...text].length, all: text.length > 0 });

const wordStart = (chars, cur) => {
  let i = cur;
  while (i > 0 && /[\s/.?&=#:-]/.test(chars[i - 1])) i--;
  while (i > 0 && !/[\s/.?&=#:-]/.test(chars[i - 1])) i--;
  return i;
};
const wordEnd = (chars, cur) => {
  let i = cur;
  while (i < chars.length && /[\s/.?&=#:-]/.test(chars[i])) i++;
  while (i < chars.length && !/[\s/.?&=#:-]/.test(chars[i])) i++;
  return i;
};

/**
 * The address after a key or a paste, as a browser's field takes them: with all of it
 * selected (as it is when the field opens), typing replaces it and an arrow goes to its end.
 */
export function editKey(e, ev) {
  const chars = [...e.text];
  let cur = Math.min(e.cur, chars.length), all = e.all;
  const put = (text) => {
    const add = [...text];
    if (all) { chars.length = 0; cur = 0; }
    chars.splice(cur, 0, ...add);
    cur += add.length; all = false;
  };
  const drop = (from, to) => { chars.splice(from, to - from); cur = from; };
  const mod = ev.alt || ev.ctrl;
  if (ev.type === 'paste') put(ev.text.replace(/[\r\n]+/g, ' ').trim());
  else if (ev.type !== 'key') return e;
  else if (ev.ctrl && ev.name === 'a') all = chars.length > 0;
  else if (ev.name === 'Backspace' || (ev.ctrl && ev.name === 'w')) {
    if (all) drop(0, chars.length);
    else if (cur > 0) drop(mod ? wordStart(chars, cur) : cur - 1, cur);
    all = false;
  } else if (ev.name === 'Delete') {
    if (all) drop(0, chars.length);
    else if (cur < chars.length) drop(cur, mod ? wordEnd(chars, cur) : cur + 1);
    all = false;
  } else if (ev.ctrl && ev.name === 'u') { drop(0, chars.length); all = false; }
  else if (ev.ctrl && ev.name === 'k') { if (all) drop(0, chars.length); else chars.length = cur; all = false; }
  else if (ev.name === 'ArrowLeft') { cur = all ? 0 : mod ? wordStart(chars, cur) : Math.max(0, cur - 1); all = false; }
  else if (ev.name === 'ArrowRight') { cur = all ? chars.length : mod ? wordEnd(chars, cur) : Math.min(chars.length, cur + 1); all = false; }
  else if (ev.name === 'Home') { cur = 0; all = false; }
  else if (ev.name === 'End' || (ev.ctrl && ev.name === 'e')) { cur = chars.length; all = false; }
  else if (!ev.ctrl && !ev.alt && !ev.meta && [...ev.name].length === 1) put(ev.name);
  else return e;
  return { text: chars.join(''), cur, all };
}
