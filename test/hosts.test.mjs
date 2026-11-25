// The multiplexers' adapters, against stand-ins for their commands: no Herdr, Rex or Tern runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hostOf } from '../src/hosts.mjs';

/** A folder with a command that logs how it was called and prints what `answers` says for its first words. */
function standIn(name, answers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-host-'));
  const file = path.join(dir, name);
  const cases = Object.entries(answers).map(([words, out]) => `  "${words}"*) cat <<'JSON'\n${JSON.stringify(out)}\nJSON\n  ;;`).join('\n');
  fs.writeFileSync(file, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >>"${dir}/calls"\nprintf '%s\\n' ==== >>"${dir}/calls"\ncase "$*" in\n${cases}\n  *) echo "unexpected: $*" >&2; exit 1 ;;\nesac\n`, { mode: 0o755 });
  const calls = () => fs.readFileSync(path.join(dir, 'calls'), 'utf8').split('\n====\n').filter(Boolean).map((c) => c.split('\n'));
  return { dir, file, calls };
}

test('the multiplexer is known by what it tells its terminals', () => {
  assert.equal(hostOf({}), null);
  assert.equal(hostOf({ HC_TERMINAL_ID: 't7' }).name, 'Herdr');
  assert.equal(hostOf({ REX_BLOCK: 'block:1' }).name, 'Rex');
  assert.equal(hostOf({ TERN_PANE: '42' }).name, 'Tern');
  // A server started from another multiplexer's terminal passes that one's variables on.
  assert.equal(hostOf({ HC_TERMINAL_ID: 't7', REX_BLOCK: 'block:1', TERM_PROGRAM: 'rex' }).name, 'Rex');
  assert.equal(hostOf({ HC_TERMINAL_ID: 't7', REX_BLOCK: 'block:1', TERM_PROGRAM: 'ghostty' }).name, 'Herdr');
  assert.equal(hostOf({ HC_TERMINAL_ID: 't7', TERN_PANE: '42', TERM_PROGRAM: 'tern' }).name, 'Tern');
  assert.equal(hostOf({ REX_BLOCK: 'block:1', CHROME_PANE_HOST: 'none' }), null);
  assert.equal(hostOf({ CHROME_PANE_HOST: 'tern' }).name, 'Tern');
});

test('Rex: the pane of this tab, and a new one beside this pane', () => {
  const rex = standIn('rex', {
    'block inspect block:me': { session_id: 'session:s', block: { block_id: 'block:me', window_id: 'window:a' } },
    'block ls -s session:s': { blocks: [{ block_id: 'block:me', window_id: 'window:a' }, { block_id: 'block:chrome', window_id: 'window:a' }, { block_id: 'block:far', window_id: 'window:b' }] },
    'split': { anchor_id: 'block:me', block_ids: ['block:new'] },
  });
  const env = { REX_BLOCK: 'block:me', REX_BIN_DIR: rex.dir, PATH: '/usr/bin:/bin', CHROME_PANE_STATE: '/tmp/state' };
  const host = hostOf(env);
  assert.deepEqual(host.where(env), { host: 'rex', terminal: 'block:me' });

  const viewers = [
    { pid: 1, host: 'rex', terminal: 'block:far' },       // a pane of another tab
    { pid: 2, host: 'rex', terminal: 'block:chrome' },
    { pid: 3, host: 'tern', terminal: 'block:chrome' },   // another multiplexer's, whatever its id
    { pid: 4, space: 's', tab: 't', terminal: 't9' },     // Herdr's
  ];
  assert.deepEqual(host.panes(viewers, env).map((p) => p.pid), [2]);
  assert.equal(host.starting(env), null);

  const opened = host.open(['https://example.com/?a=b&c=d', '--quality', 'fast'], env);
  assert.equal(opened.terminal, 'block:new');
  assert.equal(opened.match([...viewers, { pid: 9, host: 'rex', terminal: 'block:new' }]).pid, 9);
  assert.equal(opened.match(viewers), undefined);
  const call = rex.calls().at(-1);
  assert.deepEqual(call.slice(0, 7), ['split', '-b', 'block:me', '--split=right', '--focus=false', '--label', 'Chrome']);
  // After --: the state folder the caller was told, this node, the viewer and what to show.
  const cmd = call.slice(call.indexOf('--') + 1);
  assert.deepEqual([cmd[0], cmd[1], cmd[2]], ['/usr/bin/env', 'CHROME_PANE_STATE=/tmp/state', process.execPath]);
  assert.match(cmd[3], /chrome-pane\.mjs$/);
  assert.deepEqual(cmd.slice(4), ['view', 'https://example.com/?a=b&c=d', '--quality', 'fast']);
  assert.ok(host.open([], env, { focus: true }) && rex.calls().at(-1).includes('--focus=true'));
});

test('Tern: the pane of this tab, and a new one beside this pane', () => {
  const tabs = { sessions: [{ tabs: [
    { blocks: [{ id: 4294967299 }, { id: 8589934593 }] },
    { blocks: [{ id: 77 }] },
  ] }], detached: [] };
  const tern = standIn('tern', { 'ls --json': tabs, 'split': { session: 1, tab: 2, block: 12884901889 }, 'focus': {} });
  const env = { TERN_PANE: '4294967299', TERN_EXE: tern.file, PATH: '/usr/bin:/bin' };
  const host = hostOf(env);
  assert.deepEqual(host.where(env), { host: 'tern', terminal: '4294967299' });

  const viewers = [{ pid: 1, host: 'tern', terminal: '77' }, { pid: 2, host: 'tern', terminal: '8589934593' }, { pid: 3, host: 'rex', terminal: '8589934593' }];
  assert.deepEqual(host.panes(viewers, env).map((p) => p.pid), [2]);
  // A pane that is in no tab any more cannot say which tab is its own.
  assert.throws(() => host.panes(viewers, { ...env, TERN_PANE: '5' }), /in no Tern tab/);

  const opened = host.open(['example.com'], env);
  assert.equal(opened.terminal, '12884901889');
  assert.equal(opened.match([{ pid: 9, host: 'tern', terminal: '12884901889' }]).pid, 9);
  const call = tern.calls().at(-1);
  assert.deepEqual(call.slice(0, 3), ['split', '4294967299', 'right']);
  assert.deepEqual(call.slice(-2), ['view', 'example.com']);
  // The new block does not take the focus by itself: a person who asked for the pane is given it.
  host.open([], env, { focus: true });
  assert.deepEqual(tern.calls().at(-1), ['focus', '12884901889']);
});

test('a multiplexer whose command fails says why', () => {
  const rex = standIn('rex', {});
  const env = { REX_BLOCK: 'block:me', REX_BIN_DIR: rex.dir, PATH: '/usr/bin:/bin' };
  assert.throws(() => hostOf(env).panes([], env), /unexpected: block inspect block:me --json/);
});
