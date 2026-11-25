import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import { changedCells, decodePng, encodePng } from '../src/png.mjs';

/** A picture w by h whose pixel at x, y is f(x, y), three bytes each. */
function picture(w, h, f) {
  const stride = 1 + w * 3, data = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), y * stride + 1 + x * 3);
  return { w, h, bpp: 3, color: 2, stride, data };
}
const plain = (x, y) => [x * 7 & 255, y * 5 & 255, (x + y) & 255];

test('a picture written and read again is the same', () => {
  const img = picture(40, 30, plain);
  const back = decodePng(encodePng(img, 0, 0, 40, 30));
  assert.equal(back.w, 40); assert.equal(back.h, 30);
  assert.ok(back.data.equals(img.data));
  const part = decodePng(encodePng(img, 10, 5, 8, 4).toString('base64'));
  assert.deepEqual([...part.data.subarray(1, 4)], plain(10, 5));
  assert.deepEqual([...part.data.subarray(part.stride * 3 + 1 + 7 * 3, part.stride * 3 + 4 + 7 * 3)], plain(17, 8));
});

test('every way a PNG stores a row is read', () => {
  const img = picture(16, 12, plain), stride = img.stride, bpp = 3;
  for (const filter of [1, 2, 3, 4]) {
    const rows = Buffer.alloc(img.data.length);
    for (let y = 0; y < img.h; y++) {
      rows[y * stride] = filter;
      for (let i = 1; i < stride; i++) {
        const at = y * stride + i, a = i > bpp ? img.data[at - bpp] : 0, b = y ? img.data[at - stride] : 0, c = y && i > bpp ? img.data[at - stride - bpp] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const guess = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        rows[at] = (img.data[at] - guess) & 255;
      }
    }
    // The same file encodePng writes, with these rows in it.
    const png = encodePng(img, 0, 0, 16, 12), idatAt = png.indexOf('IDAT', 0, 'latin1');
    const head = png.subarray(0, idatAt - 4), packed = zlib.deflateSync(rows);
    const len = Buffer.alloc(4); len.writeUInt32BE(packed.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(packed, zlib.crc32(Buffer.from('IDAT'))) >>> 0);
    const back = decodePng(Buffer.concat([head, len, Buffer.from('IDAT'), packed, crc, png.subarray(png.length - 12)]));
    assert.ok(back && back.data.equals(img.data), `filter ${filter}`);
  }
  assert.equal(decodePng('not a png'), null);
});

test('what changed between two pictures, in cells', () => {
  const a = picture(100, 80, plain);
  const same = changedCells(a, picture(100, 80, plain), 10, 20);
  assert.deepEqual(same.rects, []);
  // One pixel in the cell at column 3, row 1; a block over columns 6-8, rows 2-3.
  const b = picture(100, 80, (x, y) => (x === 35 && y === 25) || (x >= 62 && x < 85 && y >= 45 && y < 70) ? [1, 2, 3] : plain(x, y));
  const d = changedCells(a, b, 10, 20);
  assert.deepEqual(d.rects, [{ c0: 3, c1: 9, r0: 1, r1: 4 }]);
  const c = picture(100, 80, (x, y) => (y === 0 && x === 0) || (y === 79 && x === 99) ? [9, 9, 9] : plain(x, y));
  assert.deepEqual(changedCells(a, c, 10, 20).rects, [{ c0: 0, c1: 1, r0: 0, r1: 1 }, { c0: 9, c1: 10, r0: 3, r1: 4 }]);
  assert.equal(changedCells(a, picture(90, 80, plain), 10, 20), null);
});
