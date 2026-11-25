import assert from 'node:assert/strict';
import test from 'node:test';
import { actAt, barParts, cut, editKey, editOf, looks, paint } from '../src/bar.mjs';
import { InputParser } from '../src/input.mjs';
import { width } from '../src/util.mjs';

const text = (parts) => parts.map((p) => p.text).join('');
const page = { mode: 'page', url: 'https://example.com/a/b', title: 'Example', back: true, fwd: false, loading: false, tabs: 3 };
const key = (name, m = {}) => ({ type: 'key', name, ctrl: false, alt: false, meta: false, shift: false, ...m });
const typed = (e, ...keys) => keys.reduce((at, k) => editKey(at, typeof k === 'string' ? key(k) : k), e);

test('the bar is exactly as wide as the pane, whatever it says', () => {
  const states = [page, { ...page, loading: true }, { ...page, agent: 'click "Next"' }, { ...page, dialog: { type: 'confirm', message: 'Leave?' } },
    { ...page, resend: true }, { ...page, hidden: true }, { ...page, notice: 'Ctrl+C copies in the page' }, { ...page, edit: editOf(page.url) },
    { ...page, edit: editOf('') }, { ...page, url: `https://example.com/${'x'.repeat(300)}`, title: '日本語のタイトル' }, { mode: 'tabs' },
    { mode: 'tabs', closing: 'Inbox' }, { mode: 'message' }];
  for (const s of states) for (const cols of [1, 2, 7, 12, 30, 59, 80, 100, 160]) assert.equal(width(text(barParts(s, cols))), cols, `${JSON.stringify(s).slice(0, 60)} at ${cols}`);
  assert.deepEqual(barParts(page, 0), []);
});

test('a page: its buttons, its address, its tabs', () => {
  const parts = barParts(page, 80);
  assert.match(text(parts), /^ ‹ {2}› {2}↻ {3}example\.com\/a\/b {2}· {2}Example {30,}3 tabs $/);
  // Each button is where it is drawn, three cells wide; the field between them is the address.
  assert.deepEqual([0, 2, 3, 5, 6, 8, 9].map((c) => actAt(parts, c)), ['back', 'back', null, null, 'reload', 'reload', null]);
  assert.equal(actAt(parts, 20), 'address');
  assert.equal(actAt(parts, 75), 'tabs');
  assert.equal(actAt(parts, 200), null);
  // No page to go forward to: the button is dimmed and takes no click.
  assert.deepEqual(parts.filter((p) => p.style === 'off').map((p) => p.text), [' › ']);
  // The site stands out of its address.
  assert.deepEqual(parts.filter((p) => p.style === 'strong').map((p) => p.text), ['example.com']);
  assert.match(text(barParts({ ...page, tabs: 1 }, 80)), / 1 tab $/);
});

test('while the page loads, reload is stop', () => {
  const parts = barParts({ ...page, loading: true }, 80);
  assert.equal(actAt(parts, 7), 'stop');
  assert.match(text(parts), /^ ‹  ›  ✕ /);
});

test('the keys are named where there is room, and go first when there is not', () => {
  assert.match(text(barParts(page, 140)), /\^L address · \^T tabs · \^Q quit $/);
  assert.doesNotMatch(text(barParts(page, 100)), /\^L/);
  // A narrow pane keeps the address over the tabs.
  assert.doesNotMatch(text(barParts(page, 30)), /tabs/);
  assert.match(text(barParts(page, 30)), /example\.com/);
});

test('a long address is cut, and the title comes only in the room it leaves', () => {
  const long = { ...page, url: 'https://example.com/a/long/way/down/to/a/page/that/is/far' };
  assert.match(text(barParts(long, 50)), /example\.com\/a\/long\/way\/d[^ ]*…/);
  assert.doesNotMatch(text(barParts(long, 50)), /Example/);
  assert.match(text(barParts(page, 80)), /example\.com\/a\/b {2}· {2}Example/);
});

test('the button under the mouse says what it does', () => {
  assert.match(text(barParts({ ...page, hot: 'back' }, 80)), /example\.com\/a\/b {2}· {2}Back {2}· {2}Alt\+←/);
  const look = looks([255, 255, 255], [0, 0, 0]);
  const lit = paint(barParts(page, 80), look, 'back');
  assert.ok(lit.startsWith(`\x1b[0;${look.hot}m ‹ \x1b[0;${look.off}m › `));
  assert.ok(lit.endsWith('\x1b[0m'));
  // The field is not a button: the mouse over it lights nothing.
  assert.ok(!paint(barParts(page, 80), look, 'address').includes(`\x1b[0;${look.hot}m`));
});

test('the bar is drawn in shades of the terminal, or in reverse video when it has told no colours', () => {
  assert.equal(looks().bar, '7');
  const look = looks([200, 200, 200], [0, 0, 0]);
  assert.equal(look.bar, '38;2;176;176;176;48;2;24;24;24');
  assert.equal(look.cursor, '38;2;0;0;0;48;2;200;200;200');
});

test('what an agent does shows in the field, the page after it', () => {
  const parts = barParts({ ...page, agent: 'click "Next"' }, 80);
  assert.match(text(parts), /● Agent: click "Next" {2}· {2}Example/);
  assert.equal(parts.find((p) => p.style === 'agent').text, '● Agent: click "Next"');
});

test('questions have buttons', () => {
  const dialog = barParts({ ...page, dialog: { type: 'confirm', message: 'Leave the page?' } }, 80);
  assert.match(text(dialog), /^ confirm: Leave the page\? +OK {3}Cancel {2}Enter · Esc $/);
  assert.equal(actAt(dialog, text(dialog).indexOf('OK')), 'dialog-ok');
  assert.equal(actAt(dialog, text(dialog).indexOf('Cancel')), 'dialog-cancel');
  assert.doesNotMatch(text(barParts({ ...page, dialog: { type: 'alert', message: 'Saved' } }, 80)), /Cancel/);
  const resend = barParts({ ...page, resend: true }, 120);
  assert.equal(actAt(resend, text(resend).indexOf('Send it again')), 'resend-yes');
  assert.equal(actAt(resend, text(resend).indexOf('Leave it')), 'resend-no');
  const hidden = barParts({ ...page, hidden: true }, 100);
  assert.equal(actAt(hidden, text(hidden).indexOf('Bring it forward')), 'front');
  const tabs = barParts({ mode: 'tabs' }, 100);
  assert.equal(actAt(tabs, text(tabs).indexOf('n new tab')), 'newtab');
  assert.equal(actAt(tabs, text(tabs).indexOf('Esc back')), 'page');
  const closing = barParts({ mode: 'tabs', closing: 'Inbox' }, 100);
  assert.equal(actAt(closing, text(closing).indexOf('Close it')), 'close-yes');
});

test('typing an address: it opens selected, as a browser\'s does', () => {
  const e = editOf('https://example.com/a');
  assert.deepEqual(e, { text: 'https://example.com/a', cur: 21, all: true });
  // Typing replaces what is selected; an arrow goes to its end and keeps it.
  assert.deepEqual(typed(e, 'x', 'y'), { text: 'xy', cur: 2, all: false });
  assert.deepEqual(typed(e, 'ArrowRight', '/', 'b'), { text: 'https://example.com/a/b', cur: 23, all: false });
  assert.deepEqual(typed(e, 'ArrowLeft', 'x'), { text: 'xhttps://example.com/a', cur: 1, all: false });
  assert.deepEqual(typed(e, 'Backspace'), { text: '', cur: 0, all: false });
  assert.deepEqual(editKey(e, { type: 'paste', text: ' new.example\n' }), { text: 'new.example', cur: 11, all: false });
  assert.deepEqual(editOf(''), { text: '', cur: 0, all: false });
});

test('typing an address: the caret moves and deletes by character and by word', () => {
  const e = typed(editOf(''), ...'example.com/one/two');
  assert.equal(e.text, 'example.com/one/two');
  assert.deepEqual(typed(e, 'ArrowLeft', 'ArrowLeft', 'Backspace'), { text: 'example.com/one/wo', cur: 16, all: false });
  assert.deepEqual(typed(e, key('Backspace', { alt: true })), { text: 'example.com/one/', cur: 16, all: false });
  assert.deepEqual(typed(e, key('w', { ctrl: true }), key('w', { ctrl: true })), { text: 'example.com/', cur: 12, all: false });
  assert.deepEqual(typed(e, 'Home', 'Delete'), { text: 'xample.com/one/two', cur: 0, all: false });
  assert.deepEqual(typed(e, 'Home', key('ArrowRight', { alt: true })), { text: e.text, cur: 7, all: false });
  assert.deepEqual(typed(e, 'Home', key('k', { ctrl: true })), { text: '', cur: 0, all: false });
  assert.deepEqual(typed(e, 'Home', key('e', { ctrl: true }), '!'), { text: `${e.text}!`, cur: 20, all: false });
  assert.deepEqual(typed(e, key('u', { ctrl: true })), { text: '', cur: 0, all: false });
  assert.deepEqual(typed(e, key('a', { ctrl: true }), 'z'), { text: 'z', cur: 1, all: false });
  // Characters of more than one code unit are one step each.
  assert.deepEqual(typed(editOf(''), '日', '😀', 'ArrowLeft', 'Backspace'), { text: '😀', cur: 0, all: false });
  // A key that means nothing here changes nothing.
  assert.equal(editKey(e, key('F5')), e);
});

test('the field keeps the caret in view', () => {
  const long = typed(editOf(''), ...`example.com/${'x'.repeat(100)}/end`);
  const end = text(barParts({ ...page, edit: long }, 60));
  assert.match(end, /x\/end /);
  assert.doesNotMatch(end, /example/);
  const start = text(barParts({ ...page, edit: typed(long, 'Home') }, 60));
  assert.match(start, /^ {2}example\.com\/x/);
  assert.match(text(barParts({ ...page, edit: editOf('') }, 80)), /Search, or type an address/);
  assert.match(text(barParts({ ...page, edit: editOf('') }, 80)), /Enter go {2}Esc cancel $/);
  assert.equal(barParts({ ...page, edit: editOf(page.url) }, 80).find((p) => p.style === 'sel').text, page.url);
});

test('text is cut to cells', () => {
  assert.equal(cut('abcdef', 4), 'abc…');
  assert.equal(cut('abc', 4), 'abc');
  assert.equal(width(cut('日本語のタイトル', 7)), 7);
  assert.equal(cut('abc', 0), '');
});

test('the terminal\'s colours are read from its answers, and are never keys', () => {
  const p = new InputParser();
  assert.deepEqual(p.feed('\x1b]11;rgb:1a1a/1b1b/2626\x1b\\\x1b]10;rgb:ff/80/00\x07x').map((e) => e.rgb ?? e.name), [[26, 27, 38], [255, 128, 0], 'x']);
  // In two pieces.
  assert.deepEqual(p.feed('\x1b]11;rgb:00'), []);
  assert.deepEqual(p.feed('00/0000/ffff\x07').map((e) => [e.which, e.rgb]), [['bg', [0, 0, 255]]]);
  // Alt and a bracket is still that.
  assert.deepEqual(p.feed('\x1b]'), []);
  assert.deepEqual(p.flush().map((e) => [e.name, e.alt]), [[']', true]]);
});

test('actions asked of a pane are taken once, in the order asked, and not when stale', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-bar-'));
  const before = process.env.CHROME_PANE_STATE;
  process.env.CHROME_PANE_STATE = dir;
  try {
    const { pushAct, takeActs, drawnBy, setDrawnBy, writeBar, readBar } = await import('../src/panes.mjs');
    pushAct(4242, 'go', 'example.com');
    await new Promise((r) => setTimeout(r, 3));
    pushAct(4242, 'back');
    pushAct(77, 'reload');
    assert.deepEqual(takeActs(4242).map((a) => [a.act, a.arg]), [['go', 'example.com'], ['back', null]]);
    assert.deepEqual(takeActs(4242), []);
    // One that waited for a viewer that was not there is not done late.
    const file = path.join(dir, 'agent', 'pane-77.0-1-0.act.json');
    fs.writeFileSync(file, JSON.stringify({ act: 'reload', arg: null, at: Date.now() - 60000 }));
    assert.deepEqual(takeActs(77).map((a) => a.act), ['reload']);
    assert.equal(fs.existsSync(file), false);
    // The multiplexer drew the controls a moment ago; an hour on, that says nothing any more.
    assert.equal(drawnBy('herdr'), false);
    setDrawnBy('herdr', true);
    assert.equal(drawnBy('herdr'), true);
    assert.equal(drawnBy('herdr', Date.now() + 2 * 3600000), false);
    setDrawnBy('herdr', false);
    assert.equal(drawnBy('herdr'), false);
    writeBar('{"v":1,"url":"https://example.com/"}');
    assert.equal(readBar(process.pid).url, 'https://example.com/');
  } finally {
    if (before === undefined) delete process.env.CHROME_PANE_STATE; else process.env.CHROME_PANE_STATE = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a question is said whole before the keys that answer it are named', () => {
  const text = (cols) => barParts({ mode: 'page', resend: true }, cols).map((p) => p.text).join('');
  assert.match(text(100), /a reload sends the form again\./);
  assert.match(text(100), / Send it again {3}Leave it /);
  assert.doesNotMatch(text(100), /any other key/);
  assert.match(text(140), /a reload sends the form again\..* Send it again {3}Leave it .*any other key/);
  assert.equal([...text(100)].length, 100);
});
