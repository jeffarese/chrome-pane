// Pure helpers, kept apart so they can be tested without a terminal or a browser.

/** What someone typed in the address bar, as a URL. */
export function normalizeUrl(input) {
  const s = input.trim();
  if (!s) return null;
  if (/^(https?|file|about|chrome|data|view-source|blob):/i.test(s)) return s;
  if (/\s/.test(s)) return 'https://www.google.com/search?q=' + encodeURIComponent(s);
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s) || /^\d+\.\d+\.\d+\.\d+(:\d+)?(\/|$)/.test(s)) return 'http://' + s;
  if (/^[^\s/]+\.[^\s/.]+(:\d+)?(\/|$)/.test(s) || /^[^\s/:]+:\d+(\/|$)/.test(s)) return (/:\d+(\/|$)/.test(s) && !s.includes('.') ? 'http://' : 'https://') + s;
  return 'https://www.google.com/search?q=' + encodeURIComponent(s);
}

/** Pixel size of a PNG, read from the start of its base64 text. */
export function pngSize(b64) {
  const head = Buffer.from(b64.slice(0, 44), 'base64');
  if (head.length < 24 || head.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
}

const wide = (cp) => (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
  || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
  || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd);
const zero = (cp) => cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f);

export function width(s) {
  let n = 0;
  for (const ch of s) { const cp = ch.codePointAt(0); n += zero(cp) ? 0 : wide(cp) ? 2 : 1; }
  return n;
}

/** Cuts or pads `s` to exactly `cols` cells; a cut ends in "…". */
export function fit(s, cols) {
  if (cols <= 0) return '';
  s = s.replace(/[\x00-\x1f\x7f]/g, ' ');
  if (width(s) <= cols) return s + ' '.repeat(cols - width(s));
  let out = '', n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0); const w = zero(cp) ? 0 : wide(cp) ? 2 : 1;
    if (n + w > cols - 1) break;
    out += ch; n += w;
  }
  return out + '…' + ' '.repeat(cols - n - 1);
}

/**
 * Where a frame of `img` pixels goes in the area under the bar: scaled to fit, keeping its
 * shape, centered across. Sizes are in cells; `row0` and `col0` are zero-based.
 */
export function place(img, term) {
  const cols = term.cols, rows = Math.max(1, term.rows - 1);
  const scale = Math.min((cols * term.cellW) / img.w, (rows * term.cellH) / img.h);
  const c = Math.min(cols, Math.max(1, Math.round((img.w * scale) / term.cellW)));
  const r = Math.min(rows, Math.max(1, Math.round((img.h * scale) / term.cellH)));
  return { c, r, col0: Math.floor((cols - c) / 2), row0: 1 };
}

/** A point of the terminal, in pixels, as a point of the page, in CSS pixels. */
export function toPage(px, py, geom, term) {
  const x0 = geom.col0 * term.cellW, y0 = geom.row0 * term.cellH;
  const fx = (px - x0) / (geom.c * term.cellW), fy = (py - y0) / (geom.r * term.cellH);
  const clamp = (v) => Math.min(1, Math.max(0, v));
  return { x: Math.round(clamp(fx) * geom.cssW), y: Math.round(clamp(fy) * geom.cssH), inside: fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 };
}
