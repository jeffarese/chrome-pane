import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputParser } from '../src/input.mjs';
import { keyCalls } from '../src/keys.mjs';
import { clean, fit, normalizeUrl, oneLine, place, pngSize, shortAddress, toPage, width } from '../src/util.mjs';

const names = (evs) => evs.map((e) => (e.type === 'key' ? `${e.ctrl ? 'C-' : ''}${e.alt ? 'A-' : ''}${e.shift ? 'S-' : ''}${e.name}` : e.type));

test('plain keys, control keys and named keys', () => {
  const p = new InputParser();
  assert.deepEqual(names(p.feed('aB\r\t\x7f\x01\x1b[A\x1b[1;3D\x1b[3~\x1b[Z\x1bOP\x1bx')),
    ['a', 'B', 'Enter', 'Tab', 'Backspace', 'C-a', 'ArrowUp', 'A-ArrowLeft', 'Delete', 'S-Tab', 'F1', 'A-x']);
});

test('a lone Esc waits, then is Escape', () => {
  const p = new InputParser();
  assert.deepEqual(p.feed('\x1b'), []);
  assert.equal(p.pending, true);
  assert.deepEqual(names(p.flush()), ['Escape']);
});

test('a sequence split across reads', () => {
  const p = new InputParser();
  assert.deepEqual(p.feed('\x1b[<0;12'), []);
  assert.deepEqual(p.feed(';34M'), [{ type: 'mouse', b: 0, x: 12, y: 34, release: false }]);
  assert.deepEqual(p.feed(Buffer.from('é').subarray(0, 1)), []);
  assert.deepEqual(names(p.feed(Buffer.from('é').subarray(1))), ['é']);
});

test('mouse, paste and replies', () => {
  const p = new InputParser();
  assert.deepEqual(p.feed('\x1b[<65;3;4M\x1b[<0;5;6m'), [
    { type: 'mouse', b: 65, x: 3, y: 4, release: false }, { type: 'mouse', b: 0, x: 5, y: 6, release: true }]);
  assert.deepEqual(p.feed('\x1b[200~hi\nthere\x1b[20'), []);
  assert.deepEqual(p.feed('1~z'), [{ type: 'paste', text: 'hi\nthere' }, { type: 'key', name: 'z', shift: false, alt: false, ctrl: false, meta: false }]);
  assert.deepEqual(p.feed('\x1b[6;34;16t\x1b[?1016;1$y\x1b[?62;22c'), [
    { type: 'reply', kind: 'cell', h: 34, w: 16 }, { type: 'reply', kind: 'mode', mode: 1016, value: 1 }, { type: 'reply', kind: 'da' }]);
});

test('keys as DevTools calls', () => {
  const [down, up] = keyCalls({ name: 'a' });
  assert.deepEqual(down.params, { type: 'keyDown', text: 'a', unmodifiedText: 'a', key: 'a', modifiers: 0, code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  assert.equal(up.params.type, 'keyUp');
  assert.equal(keyCalls({ name: '!' })[0].params.modifiers, 8);
  assert.equal(keyCalls({ name: '!' })[0].params.code, 'Digit1');
  assert.deepEqual(keyCalls({ name: 'a', ctrl: true }, false)[0].params, { type: 'rawKeyDown', key: 'a', modifiers: 2, code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  // On a Mac, Ctrl stands in for Cmd in the editing shortcuts, and the command is named.
  assert.deepEqual(keyCalls({ name: 'a', ctrl: true }, true)[0].params, { type: 'rawKeyDown', key: 'a', modifiers: 4, code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, commands: ['selectAll'] });
  assert.deepEqual(keyCalls({ name: 'Z', meta: true }, true)[0].params.commands, ['redo']);
  assert.equal(keyCalls({ name: 'l', ctrl: true }, true)[0].params.commands, undefined);
  assert.equal(keyCalls({ name: 'Enter' })[0].params.text, '\r');
  assert.equal(keyCalls({ name: 'ArrowDown', shift: true })[0].params.modifiers, 8);
  assert.deepEqual(keyCalls({ name: 'ñ' }), [{ method: 'Input.insertText', params: { text: 'ñ' } }]);
});

test('addresses', () => {
  assert.equal(normalizeUrl('example.com/a'), 'https://example.com/a');
  assert.equal(normalizeUrl('https://x.y'), 'https://x.y');
  assert.equal(normalizeUrl('localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeUrl('127.0.0.1:8080/x'), 'http://127.0.0.1:8080/x');
  assert.equal(normalizeUrl('devbox:5173'), 'http://devbox:5173');
  assert.equal(normalizeUrl('about:blank'), 'about:blank');
  assert.equal(normalizeUrl('how to tie a knot'), 'https://www.google.com/search?q=how%20to%20tie%20a%20knot');
  assert.equal(normalizeUrl('kittens'), 'https://www.google.com/search?q=kittens');
  assert.equal(normalizeUrl('  '), null);
});

test('text that fits a bar', () => {
  assert.equal(width('a日本'), 5);
  assert.equal(fit('abc', 5), 'abc  ');
  assert.equal(fit('abcdefgh', 5), 'abcd…');
  assert.equal(width(fit('日本語のタイトル', 7)), 7);
});

test('text of a page loses the control codes a terminal would obey', () => {
  assert.equal(clean('a\x1b]52;c;eA==\x07b\x9b31mc\x9d\x9cd\r\n\te'), 'a]52;c;eA==b31mcd\n\te');
  assert.equal(oneLine('a\nb\x1bc\x9bd'), 'a b c d');
  assert.equal(fit('a\x9bb', 5), 'a b  ');
});

test('the address in the bar, as a browser writes it', () => {
  assert.equal(shortAddress('https://example.com/'), 'example.com');
  assert.equal(shortAddress('https://example.com/a/?q=1'), 'example.com/a/?q=1');
  assert.equal(shortAddress('http://localhost:3000/'), 'http://localhost:3000');
  assert.equal(shortAddress('about:blank'), 'about:blank');
});

test('where a frame goes, and back to the page', () => {
  const term = { cols: 100, rows: 41, cellW: 10, cellH: 20 };
  assert.deepEqual(place({ w: 1000, h: 800 }, term), { c: 100, r: 40, col0: 0, row0: 1 });
  // A wide frame is as wide as the pane and shorter; a tall one is centered.
  assert.deepEqual(place({ w: 2000, h: 800 }, term), { c: 100, r: 20, col0: 0, row0: 1 });
  assert.deepEqual(place({ w: 500, h: 800 }, term), { c: 50, r: 40, col0: 25, row0: 1 });
  // With the controls drawn by the multiplexer, the page has the bar's row too.
  assert.deepEqual(place({ w: 1000, h: 820 }, { ...term, bar: 0 }), { c: 100, r: 41, col0: 0, row0: 0 });
  const geom = { c: 50, r: 40, col0: 25, row0: 1, cssW: 250, cssH: 400 };
  assert.deepEqual(toPage(500, 420, geom, term), { x: 125, y: 200, inside: true });
  assert.equal(toPage(100, 420, geom, term).inside, false);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 6, 64, 0, 0, 3, 132]), Buffer.alloc(8)]);
  assert.deepEqual(pngSize(png.toString('base64')), { w: 1600, h: 900 });
});

test('a terminal\'s answers to picture commands are never keys', () => {
  const p = new InputParser();
  assert.deepEqual(p.feed('\x1b_Gi=4100007;OK\x1b\\'), [{ type: 'reply', kind: 'gfx', id: 4100007, ok: true, text: 'OK' }]);
  assert.deepEqual(p.feed('\x1b_Gi=12,p=1;ENOENT: image not found\x1b\\a'),
    [{ type: 'reply', kind: 'gfx', id: 12, ok: false, text: 'ENOENT: image not found' }, { type: 'key', name: 'a', shift: false, alt: false, ctrl: false, meta: false }]);
  // Cut in two by the link: held back, even when the time for a lone Esc has passed.
  assert.deepEqual(p.feed('\x1b_Gi=7;O'), []);
  assert.deepEqual(p.flush(), []);
  assert.deepEqual(p.feed('K\x1b\\'), [{ type: 'reply', kind: 'gfx', id: 7, ok: true, text: 'OK' }]);
  // Alt+_ is still a key.
  p.feed('\x1b_');
  assert.deepEqual(p.flush().map((e) => [e.name, e.alt]), [['_', true]]);
});
