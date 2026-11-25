// Opening the viewer as a pane of the Herdr tab this was called from.
//
// Every Herdr terminal belongs to its machine's core (`hc`), and a terminal labelled with a
// space and a tab shows up in that tab on every Herdr window looking at this machine: this
// Mac's, or another computer's. So the viewer is started as such a terminal, here, next to
// Chrome, and whoever has the tab open sees it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The new terminal runs the same node this one runs under: its PATH may not have one.
const main = fileURLToPath(new URL('./chrome-pane.mjs', import.meta.url));

// A terminal Herdr's core starts has the core's PATH, which need not have hc on it.
let hcPath = null;
function hc(args) {
  hcPath ??= ['hc', path.join(os.homedir(), '.local/bin/hc'), '/opt/homebrew/bin/hc', '/usr/local/bin/hc']
    .find((c) => c === 'hc' ? !spawnSync('hc', ['--version']).error : fs.existsSync(c)) ?? 'hc';
  const r = spawnSync(hcPath, args, { encoding: 'utf8' });
  if (r.error) throw new Error('hc (herdr-core) was not found');
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `hc ${args[0]} failed`).trim());
  return r.stdout;
}

/** The space and tab of the terminal this runs in, or of the nearest parent that has them. */
export function whereAmI(env = process.env) {
  // A pane that chrome-pane opened was told where it is: it has nothing to ask.
  if (env.CHROME_PANE_SPACE && env.CHROME_PANE_TAB && env.HC_TERMINAL_ID) return { space: env.CHROME_PANE_SPACE, tab: env.CHROME_PANE_TAB, terminal: env.HC_TERMINAL_ID };
  let address = env.HC_TERMINAL_ID;
  if (!address) throw new Error('this is not a Herdr terminal: run chrome-pane in a terminal to view there');
  for (let i = 0; address && i < 8; i++) {
    const t = JSON.parse(hc(['get', address, '--json']));
    const space = t.labels?.['herdr.space'], tab = t.labels?.['herdr.tab'];
    if (space && tab) return { space, tab, terminal: t.address };
    address = t.parent;
  }
  throw new Error('this terminal is in no Herdr tab');
}

export function openPane(viewArgs, env = process.env) {
  const { space, tab } = whereAmI(env);
  // The pane is another process, started by Herdr's core with the core's environment: what
  // the caller was told about chrome-pane (which state folder, which browser, a log) goes along.
  const logs = ['CHROME_PANE_STATE', 'XDG_STATE_HOME', 'CHROME_PANE_SOCKET', 'CHROME_PANE_USER_DATA_DIR', 'CHROME_PANE_WS', 'CHROME_PANE_DEBUG', 'CHROME_PANE_TRACE']
    .filter((k) => env[k]).map((k) => `${k}=${env[k]}`);
  // And where it is, which the pane could only learn from hc, if its PATH has one.
  logs.push(`CHROME_PANE_SPACE=${space}`, `CHROME_PANE_TAB=${tab}`);
  const out = hc(['run', '--bg', '--json', '--no-parent', '--no-notify', '--cwd', os.homedir(),
    '--label', `herdr.space=${space}`, '--label', `herdr.tab=${tab}`, '--label', 'chrome-pane=1',
    '--', '/usr/bin/env', ...logs, process.execPath, main, 'view', ...viewArgs]);
  try { return JSON.parse(out).address ?? out.trim(); } catch { return out.trim(); }
}

/**
 * The process ids of the Chrome panes of a Herdr tab, as Herdr knows them (all of them, or the
 * one of a terminal). A pane's viewer is found by its pid whatever it managed to say of itself.
 */
export function panePids(here, terminal = null) {
  try {
    const addresses = terminal ? [terminal] : JSON.parse(hc(['ls', '--json', '--label', 'chrome-pane=1', '--label', `herdr.space=${here.space}`, '--label', `herdr.tab=${here.tab}`]))
      .terminals.map((t) => t.address);
    return addresses.map((a) => { try { return JSON.parse(hc(['get', a, '--json'])).pid; } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
