// The terminal multiplexers chrome-pane opens its pane in: Herdr, Rex and Tern.
//
// Each of them tells a program which pane it runs in, has a command that splits a pane and one
// that lists a tab's panes. That is what it takes to open the viewer beside the program that
// asked for it, and for an agent's command to find the pane of its own tab. A multiplexer is:
//
//   inside(env)              is this process in one of its terminals
//   where(env)               what a viewer there says of itself: { host, terminal, … }
//   panes(list, env)         of the running viewers, those of the tab this runs in
//   starting(env)            null, or how to tell a pane of this tab that has not said anything yet
//   open(viewArgs, env, o)   the viewer as a new pane beside this terminal: { terminal, match },
//                            match(list) being that pane's viewer once it runs
//   publish(text, env)       optional: tells the multiplexer what the viewer's bar would say, for
//                            controls it draws itself; resolves once it is told
//   mine(env)                optional: is the terminal the environment names the one this draws in
//
// Anywhere else chrome-pane is a program for the terminal it is run in, and an agent's
// commands act on the pane used last.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const main = fileURLToPath(new URL('./chrome-pane.mjs', import.meta.url));

// A multiplexer's own command, by the first of the places it may be at: a pane's PATH need
// not have it (Herdr's core starts terminals with its own, an agent's is often fixed).
const found = new Map();
function program(name, places, env) {
  const key = `${name}\n${places[0] ?? ''}\n${env.PATH ?? ''}`;
  if (!found.has(key)) {
    found.set(key, places.filter(Boolean).find((p) => (p.includes('/') ? fs.existsSync(p) : !spawnSync(p, ['--version'], { env }).error)) ?? name);
  }
  return found.get(key);
}
function cli(name, places, args, env) {
  const r = spawnSync(program(name, places, env), args, { encoding: 'utf8', env });
  if (r.error) throw new Error(`${name} was not found`);
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `${name} ${args[0]} failed`).trim());
  return r.stdout;
}

// The pane is another process, started by the multiplexer with its own environment: what the
// caller was told about chrome-pane (which state folder, which browser, a log) goes along. And
// it runs the node this one runs under: its PATH may not have one.
const PASSED = ['CHROME_PANE_STATE', 'XDG_STATE_HOME', 'CHROME_PANE_SOCKET', 'CHROME_PANE_USER_DATA_DIR', 'CHROME_PANE_WS', 'CHROME_PANE_DEBUG', 'CHROME_PANE_TRACE', 'CHROME_PANE_HOST'];
function viewer(viewArgs, env, more = []) {
  return ['/usr/bin/env', ...PASSED.filter((k) => env[k]).map((k) => `${k}=${env[k]}`), ...more, process.execPath, main, 'view', ...viewArgs];
}

// ---------------------------------------------------------------- Herdr
//
// Every Herdr terminal belongs to its machine's core (`hc`), and a terminal labelled with a
// space and a tab shows up in that tab on every Herdr window looking at this machine: this
// Mac's, or another computer's. So the viewer is started as such a terminal, here, next to
// Chrome, and whoever has the tab open sees it.

const HC = ['hc', path.join(os.homedir(), '.local/bin/hc'), '/opt/homebrew/bin/hc', '/usr/local/bin/hc'];
const hc = (args, env) => cli('hc', HC, args, env);
/** The label under which a viewer tells Herdr's pane header what its bar would say. */
export const HERDR_BAR = 'chrome-pane.bar';

/** The space and tab of the Herdr terminal this runs in, or of the nearest parent that has them. */
export function whereAmI(env = process.env) {
  // A pane that chrome-pane opened was told where it is: it has nothing to ask.
  if (env.CHROME_PANE_SPACE && env.CHROME_PANE_TAB && env.HC_TERMINAL_ID) return { space: env.CHROME_PANE_SPACE, tab: env.CHROME_PANE_TAB, terminal: env.HC_TERMINAL_ID };
  let address = env.HC_TERMINAL_ID;
  if (!address) throw new Error('this is not a Herdr terminal: run chrome-pane in a terminal to view there');
  for (let i = 0; address && i < 8; i++) {
    const t = JSON.parse(hc(['get', address, '--json'], env));
    const space = t.labels?.['herdr.space'], tab = t.labels?.['herdr.tab'];
    if (space && tab) return { space, tab, terminal: t.address };
    address = t.parent;
  }
  throw new Error('this terminal is in no Herdr tab');
}

/**
 * The process ids of the Chrome panes of a Herdr tab, as Herdr knows them (all of them, or the
 * one of a terminal). A pane's viewer is found by its pid whatever it managed to say of itself.
 */
function herdrPids(here, terminal, env) {
  try {
    const addresses = terminal ? [terminal] : JSON.parse(hc(['ls', '--json', '--label', 'chrome-pane=1', '--label', `herdr.space=${here.space}`, '--label', `herdr.tab=${here.tab}`], env))
      .terminals.map((t) => t.address);
    return addresses.map((a) => { try { return JSON.parse(hc(['get', a, '--json'], env)).pid; } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

const herdr = {
  id: 'herdr', name: 'Herdr', term: 'ghostty',
  inside: (env) => Boolean(env.HC_TERMINAL_ID),
  where(env) {
    // A pane that could not find out where it is still says which terminal it is.
    try { return { host: 'herdr', ...whereAmI(env) }; } catch { return { host: 'herdr', terminal: env.HC_TERMINAL_ID }; }
  },
  panes(list, env) {
    const here = whereAmI(env);
    const said = list.filter((p) => p.space === here.space && p.tab === here.tab);
    if (said.length) return said;
    // A pane that said nothing of where it is: Herdr knows whose pid is in this tab.
    const pids = herdrPids(here, null, env);
    return list.filter((p) => pids.includes(p.pid));
  },
  starting(env) {
    const pids = herdrPids(whereAmI(env), null, env);
    return pids.length ? (list) => list.find((p) => pids.includes(p.pid)) : null;
  },
  // Whether this process draws in the Herdr terminal its environment names, and not in one of
  // another program's that runs inside it (tmux, a test's pty): only then are that terminal's
  // labels this viewer's to write.
  mine(env) {
    try {
      const t = JSON.parse(hc(['get', env.HC_TERMINAL_ID, '--json'], env));
      if (t.pid === process.pid) return true;
      const tty = (pid) => spawnSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
      const here = tty(process.pid);
      return Boolean(here) && !here.startsWith('?') && here === tty(t.pid);
    } catch { return false; }
  },
  // A label on the viewer's terminal: every Herdr window showing the pane reads it, on this
  // computer or another. Not waited for: the viewer has frames to draw meanwhile.
  publish(text, env) {
    return new Promise((resolve) => {
      const child = spawn(program('hc', HC, env), ['label', env.HC_TERMINAL_ID, `${HERDR_BAR}=${text}`], { stdio: 'ignore', env });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  },
  open(viewArgs, env) {
    const here = whereAmI(env);
    // Where it is goes along too: the pane could only learn it from hc, if its PATH has one.
    const out = hc(['run', '--bg', '--json', '--no-parent', '--no-notify', '--cwd', os.homedir(),
      '--label', `herdr.space=${here.space}`, '--label', `herdr.tab=${here.tab}`, '--label', 'chrome-pane=1',
      '--', ...viewer(viewArgs, env, [`CHROME_PANE_SPACE=${here.space}`, `CHROME_PANE_TAB=${here.tab}`])], env);
    let terminal = out.trim();
    try { terminal = JSON.parse(out).address ?? terminal; } catch {}
    const pids = herdrPids(here, terminal, env);
    return { terminal, match: (list) => list.find((p) => pids.includes(p.pid)) };
  },
};

// ---------------------------------------------------------------- Rex
//
// Rex gives a pane its id as REX_BLOCK, which stays the pane's when its tab moves. `rex split`
// puts a pane beside one, and Rex's server keeps it for every app showing the session, on this
// computer or another.

const rexCli = (args, env) => cli('rex', [env.REX_BIN_DIR && path.join(env.REX_BIN_DIR, 'rex'), 'rex', path.join(os.homedir(), '.local/bin/rex')], args, env);

/** The panes of the Rex tab (a "window" to Rex) that holds this pane now. */
function rexTab(env) {
  const mine = JSON.parse(rexCli(['block', 'inspect', env.REX_BLOCK, '--json'], env));
  const { blocks } = JSON.parse(rexCli(['block', 'ls', '-s', mine.session_id, '--json'], env));
  return blocks.filter((b) => b.window_id === mine.block.window_id).map((b) => b.block_id);
}

const rex = {
  id: 'rex', name: 'Rex', term: 'rex',
  inside: (env) => Boolean(env.REX_BLOCK),
  where: (env) => ({ host: 'rex', terminal: env.REX_BLOCK }),
  panes(list, env) {
    const ids = rexTab(env);
    return list.filter((p) => p.host === 'rex' && ids.includes(p.terminal));
  },
  starting: () => null,
  open(viewArgs, env, { focus = false } = {}) {
    // --shell=none: the command is started as given, with nothing of a shell's to read first.
    const out = JSON.parse(rexCli(['split', '-b', env.REX_BLOCK, '--split=right', `--focus=${focus}`, '--label', 'Chrome', '--shell=none',
      '-c', os.homedir(), '--json', '--', ...viewer(viewArgs, env)], env));
    const terminal = out.block_ids?.[0];
    if (!terminal) throw new Error('Rex opened no pane');
    return { terminal, match: (list) => list.find((p) => p.host === 'rex' && p.terminal === terminal) };
  },
};

// ---------------------------------------------------------------- Tern
//
// Tern gives a pane its block's id as TERN_PANE and the path of its own program as TERN_EXE.
// `tern split` puts a block beside one, and leaves the focus where it was.

const ternCli = (args, env) => cli('tern', [env.TERN_EXE, 'tern', path.join(os.homedir(), '.local/bin/tern'), '/Applications/Tern.app/Contents/MacOS/tern'], args, env);

/** The blocks of the Tern tab that holds this pane now. */
function ternTab(env) {
  const { sessions } = JSON.parse(ternCli(['ls', '--json'], env));
  for (const s of sessions ?? []) {
    for (const t of s.tabs ?? []) {
      const ids = (t.blocks ?? []).map((b) => String(b.id));
      if (ids.includes(String(env.TERN_PANE))) return ids;
    }
  }
  throw new Error('this pane is in no Tern tab');
}

const tern = {
  id: 'tern', name: 'Tern', term: 'tern',
  inside: (env) => Boolean(env.TERN_PANE),
  where: (env) => ({ host: 'tern', terminal: String(env.TERN_PANE) }),
  panes(list, env) {
    const ids = ternTab(env);
    return list.filter((p) => p.host === 'tern' && ids.includes(p.terminal));
  },
  starting: () => null,
  open(viewArgs, env, { focus = false } = {}) {
    const out = JSON.parse(ternCli(['split', String(env.TERN_PANE), 'right', '--cwd', os.homedir(), '--json', '--', ...viewer(viewArgs, env)], env));
    if (out.block == null) throw new Error('Tern opened no pane');
    const terminal = String(out.block);
    if (focus) try { ternCli(['focus', terminal], env); } catch {}
    return { terminal, match: (list) => list.find((p) => p.host === 'tern' && p.terminal === terminal) };
  },
};

// ----------------------------------------------------------------

export const HOSTS = [herdr, rex, tern];

/** The multiplexer this process runs in, or null in any other terminal. CHROME_PANE_HOST names one, or "none". */
export function hostOf(env = process.env) {
  if (env.CHROME_PANE_HOST) return HOSTS.find((h) => h.id === env.CHROME_PANE_HOST) ?? null;
  const inside = HOSTS.filter((h) => h.inside(env));
  // A server started from another multiplexer's terminal hands that one's variables down to
  // its own terminals: the terminal's own name says whose it is.
  return inside.find((h) => h.term === env.TERM_PROGRAM) ?? inside[0] ?? null;
}
