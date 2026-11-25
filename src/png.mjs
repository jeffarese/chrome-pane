// Just enough PNG to send a terminal only the part of a picture that changed.
//
// Chrome sends every frame of a tab whole. Over a network that is megabytes for a row that lit
// up under the mouse. So the viewer opens each frame (decodePng), compares it with the one on
// screen (changedCells), and sends the cells that differ as a small picture of their own
// (encodePng) to lay over the big one.
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A PNG as rows of pixels: { w, h, bpp, color, stride, data }, each row `stride` bytes, the
 * first of them unused. null for a kind of PNG this does not read (Chrome's are 8-bit RGB or
 * RGBA, not interlaced).
 */
export function decodePng(input) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'base64') : input;
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) return null;
  let ihdr = null;
  const idat = [];
  for (let at = 8; at + 12 <= buf.length;) {
    const len = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8);
    if (type === 'IHDR') ihdr = buf.subarray(at + 8, at + 8 + len);
    else if (type === 'IDAT') idat.push(buf.subarray(at + 8, at + 8 + len));
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  if (!ihdr || ihdr.length < 13 || ihdr[8] !== 8 || ihdr[12] !== 0) return null;
  const w = ihdr.readUInt32BE(0), h = ihdr.readUInt32BE(4), color = ihdr[9];
  const bpp = color === 6 ? 4 : color === 2 ? 3 : 0;
  if (!bpp || !w || !h) return null;
  const stride = 1 + w * bpp;
  let d;
  try { d = zlib.inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat)); } catch { return null; }
  if (d.length < stride * h) return null;
  // Each row is stored as its difference from its neighbours, in one of five ways.
  for (let y = 0; y < h; y++) {
    const row = y * stride, filter = d[row], from = row + 1, to = row + stride;
    d[row] = 0;
    if (filter === 0) continue;
    if (filter === 2) { if (y) for (let i = from; i < to; i++) d[i] += d[i - stride]; }
    else if (filter === 1) { for (let i = from + bpp; i < to; i++) d[i] += d[i - bpp]; }
    else if (filter === 3) {
      for (let i = from; i < to; i++) d[i] += ((i - from >= bpp ? d[i - bpp] : 0) + (y ? d[i - stride] : 0)) >> 1;
    } else if (filter === 4) {
      for (let i = from; i < to; i++) {
        const a = i - from >= bpp ? d[i - bpp] : 0, b = y ? d[i - stride] : 0, c = y && i - from >= bpp ? d[i - stride - bpp] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        d[i] += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
    } else return null;
  }
  return { w, h, bpp, color, stride, data: d };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(data, zlib.crc32(head.subarray(4))) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** The rectangle x, y, w, h (in pixels) of a decoded picture, as a PNG. */
export function encodePng(img, x, y, w, h) {
  const stride = 1 + w * img.bpp, rows = Buffer.alloc(stride * h);
  for (let r = 0; r < h; r++) {
    const from = (y + r) * img.stride + 1 + x * img.bpp;
    img.data.copy(rows, r * stride + 1, from, from + w * img.bpp);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = img.color;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: w * h > 500000 ? 1 : 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Where two pictures of the same size differ, as rectangles of cells { c0, c1, r0, r1 } (ends
 * not included), cells being cw by ch pixels: one rectangle for each run of rows that changed,
 * as wide as what changed in them. `share` is the part of the picture they cover.
 */
export function changedCells(a, b, cw, ch) {
  if (a.w !== b.w || a.h !== b.h || a.bpp !== b.bpp) return null;
  const cols = Math.ceil(a.w / cw), rows = Math.ceil(a.h / ch), cell = cw * a.bpp;
  const rects = [];
  let open = null, area = 0;
  for (let r = 0; r < rows; r++) {
    let c0 = cols, c1 = 0;
    for (let y = r * ch, end = Math.min(a.h, y + ch); y < end; y++) {
      const row = y * a.stride;
      if (a.data.compare(b.data, row, row + a.stride, row, row + a.stride) === 0) continue;
      // Narrow in from both sides to the cells that differ in this row.
      let lo = 0, hi = cols;
      while (lo < hi) { const s = row + 1 + lo * cell, e = Math.min(row + a.stride, s + cell); if (a.data.compare(b.data, s, e, s, e) !== 0) break; lo++; }
      while (hi > lo) { const s = row + 1 + (hi - 1) * cell, e = Math.min(row + a.stride, s + cell); if (a.data.compare(b.data, s, e, s, e) !== 0) break; hi--; }
      if (lo < c0) c0 = lo;
      if (hi > c1) c1 = hi;
    }
    if (c0 >= c1) { open = null; continue; }
    if (open) { open.r1 = r + 1; area -= (open.c1 - open.c0) * (r - open.r0); open.c0 = Math.min(open.c0, c0); open.c1 = Math.max(open.c1, c1); area += (open.c1 - open.c0) * (open.r1 - open.r0); }
    else { open = { c0, c1, r0: r, r1: r + 1 }; rects.push(open); area += c1 - c0; }
  }
  return { rects, share: area / (cols * rows) };
}
