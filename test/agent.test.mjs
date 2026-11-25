import assert from 'node:assert/strict';
import test from 'node:test';
import { keyEvent, webAddress, words } from '../src/agent.mjs';
import { whereAmI } from '../src/herdr.mjs';

test('a batch line splits into words, quotes keeping them together', () => {
  assert.deepEqual(words('fill e12 "Ada Lovelace"'), ['fill', 'e12', 'Ada Lovelace']);
  assert.deepEqual(words("select e5 'Two words'  "), ['select', 'e5', 'Two words']);
  assert.deepEqual(words('fill e2 ""'), ['fill', 'e2', '']);
  assert.deepEqual(words('type "say \\"hi\\""'), ['type', 'say "hi"']);
  assert.deepEqual(words('   '), []);
  assert.throws(() => words('fill e2 "open'), /quote/);
});

test('open takes addresses of the web only', () => {
  assert.equal(webAddress('example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(webAddress('http://example.com'), 'http://example.com/');
  assert.equal(webAddress('localhost:3000/x'), 'http://localhost:3000/x');
  assert.equal(webAddress('127.0.0.1:8080'), 'http://127.0.0.1:8080/');
  assert.equal(webAddress('about:blank'), 'about:blank');
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'data:text/html,x', 'view-source:https://example.com', '', 'frobnicate'])
    assert.throws(() => webAddress(bad), undefined, bad);
});

test('keys by their names, with modifiers', () => {
  assert.deepEqual(keyEvent('Enter'), { type: 'key', name: 'Enter', shift: false, alt: false, ctrl: false, meta: false });
  assert.equal(keyEvent('esc').name, 'Escape');
  assert.equal(keyEvent('down').name, 'ArrowDown');
  const k = keyEvent('ctrl+shift+a');
  assert.ok(k.ctrl && k.shift && k.name === 'a');
  assert.equal(keyEvent('ctrl++').name, '+');
  assert.throws(() => keyEvent('hyper+a'), /not a key/);
});

test('a pane that chrome-pane opened knows where it is without asking Herdr', () => {
  // The core that starts a pane may have no hc on its PATH: the place comes with the pane.
  assert.deepEqual(whereAmI({ HC_TERMINAL_ID: 't9', CHROME_PANE_SPACE: 'sp1', CHROME_PANE_TAB: 'tb2', PATH: '/nowhere' }), { space: 'sp1', tab: 'tb2', terminal: 't9' });
  assert.throws(() => whereAmI({}), /not a Herdr terminal/);
});
