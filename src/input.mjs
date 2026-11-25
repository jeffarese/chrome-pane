// Turns what the terminal sends (keys, mouse reports, pastes, replies to queries) into events.
import { StringDecoder } from 'node:string_decoder';

const CSI = /\x1b\[([<?>=]?)([0-9;:]*)([ -\/]*)([@-~])/y;
const TILDE = { 1: 'Home', 2: 'Insert', 3: 'Delete', 4: 'End', 5: 'PageUp', 6: 'PageDown', 7: 'Home', 8: 'End',
  11: 'F1', 12: 'F2', 13: 'F3', 14: 'F4', 15: 'F5', 17: 'F6', 18: 'F7', 19: 'F8', 20: 'F9', 21: 'F10', 23: 'F11', 24: 'F12' };
const LETTER = { A: 'ArrowUp', B: 'ArrowDown', C: 'ArrowRight', D: 'ArrowLeft', H: 'Home', F: 'End', P: 'F1', Q: 'F2', R: 'F3', S: 'F4' };
const PASTE_END = '\x1b[201~';

const key = (name, m = {}) => ({ type: 'key', name, shift: !!m.shift, alt: !!m.alt, ctrl: !!m.ctrl, meta: !!m.meta });
function mods(n) {
  const m = Math.max(0, (n || 1) - 1);
  return { shift: !!(m & 1), alt: !!(m & 2), ctrl: !!(m & 4), meta: !!(m & 8) };
}
function charKey(c) {
  const code = c.codePointAt(0);
  if (c === '\r' || c === '\n') return key('Enter');
  if (c === '\t') return key('Tab');
  if (code === 0x7f || code === 0x08) return key('Backspace');
  if (code === 0) return key(' ', { ctrl: true });
  if (code < 0x1b) return key(String.fromCharCode(code + 96), { ctrl: true });
  if (code < 0x20) return key('\\]^_'[code - 0x1c], { ctrl: true });
  return key(c);
}

/** What a terminal says of a picture command: `i=7,p=1;OK`, or an error like `i=7;ENOENT: image not found`. */
function gfxReply(body) {
  const cut = body.indexOf(';');
  const head = cut < 0 ? body : body.slice(0, cut), text = cut < 0 ? '' : body.slice(cut + 1);
  return { type: 'reply', kind: 'gfx', id: Number(/(?:^|,)i=(\d+)/.exec(head)?.[1] ?? 0), ok: text === 'OK', text };
}

export class InputParser {
  constructor() { this.dec = new StringDecoder('utf8'); this.buf = ''; this.paste = null; this.apcAt = 0; }

  /** True when bytes are held back that may be the start of a longer sequence (a lone Esc). */
  get pending() { return this.paste === null && this.buf.length > 0; }

  feed(chunk) { this.buf += typeof chunk === 'string' ? chunk : this.dec.write(chunk); return this.parse(false); }
  /** Nothing more is coming: what is held back is what it looks like. */
  flush() { return this.parse(true); }

  parse(flush) {
    const out = [], s = this.buf;
    let i = 0;
    if (!s.startsWith('\x1b_')) this.apcAt = 0;
    while (i < s.length) {
      if (this.paste !== null) {
        const end = s.indexOf(PASTE_END, i);
        if (end >= 0) { out.push({ type: 'paste', text: this.paste + s.slice(i, end) }); this.paste = null; i = end + PASTE_END.length; continue; }
        // Keep back a tail that may be the start of the end marker.
        const esc = s.lastIndexOf('\x1b');
        const cut = esc >= i && esc > s.length - PASTE_END.length ? esc : s.length;
        this.paste += s.slice(i, cut); i = cut;
        break;
      }
      if (s[i] !== '\x1b') { const cp = String.fromCodePoint(s.codePointAt(i)); out.push(charKey(cp)); i += cp.length; continue; }
      if (i + 1 >= s.length) { if (!flush) break; out.push(key('Escape')); i++; continue; }
      const n = s[i + 1];
      if (n === '[') {
        CSI.lastIndex = i;
        const m = CSI.exec(s);
        if (m) { i = CSI.lastIndex; const ev = this.csi(m); if (ev) out.push(ev); continue; }
        if (!flush && s.length - i < 48) break;
        out.push(key('Escape')); i++; continue;
      }
      if (n === '_' && (i + 2 >= s.length ? !flush : s[i + 2] === 'G')) {
        // The terminal's answer to a picture command, Esc _ G … Esc \: never keys for the page.
        const end = s.indexOf('\x1b\\', i + 2);
        if (end >= 0) { this.apcAt = 0; out.push(gfxReply(s.slice(i + 3, end))); i = end + 2; continue; }
        // The rest of it is on its way. One that never ends is dropped whole after a second.
        this.apcAt ||= Date.now();
        if (s.length - i < 512 && Date.now() - this.apcAt < 1000) break;
        this.apcAt = 0; i = s.length; continue;
      }
      if (n === 'O') {
        if (i + 2 >= s.length) { if (!flush) break; } else if (LETTER[s[i + 2]]) { out.push(key(LETTER[s[i + 2]])); i += 3; continue; }
      }
      if (n === '\x1b') { out.push(key('Escape')); i++; continue; }
      const cp = String.fromCodePoint(s.codePointAt(i + 1));
      out.push({ ...charKey(cp), alt: true }); i += 1 + cp.length;
    }
    this.buf = s.slice(i);
    return out;
  }

  csi([, prefix, params, , final]) {
    const p = params.split(/[;:]/).map((x) => (x === '' ? 0 : Number(x)));
    if (prefix === '<') return final === 'M' || final === 'm' ? { type: 'mouse', b: p[0], x: p[1], y: p[2], release: final === 'm' } : null;
    if (prefix === '?') {
      if (final === 'y') return { type: 'reply', kind: 'mode', mode: p[0], value: p[1] };
      if (final === 'c') return { type: 'reply', kind: 'da' };
      return null;
    }
    if (prefix) return null;
    if (final === 't') {
      if (p[0] === 6) return { type: 'reply', kind: 'cell', h: p[1], w: p[2] };
      if (p[0] === 4) return { type: 'reply', kind: 'pixels', h: p[1], w: p[2] };
      return null;
    }
    if (final === '~') {
      if (p[0] === 200) { this.paste = ''; return null; }
      return TILDE[p[0]] ? key(TILDE[p[0]], mods(p[1])) : null;
    }
    if (final === 'u') {
      const names = { 13: 'Enter', 9: 'Tab', 27: 'Escape', 127: 'Backspace' };
      return p[0] ? key(names[p[0]] ?? String.fromCodePoint(p[0]), mods(p[1])) : null;
    }
    if (final === 'Z') return key('Tab', { shift: true });
    if (final === 'I' || final === 'O') return { type: 'focus', in: final === 'I' };
    if (LETTER[final]) return key(LETTER[final], mods(p[1]));
    return null;
  }
}
