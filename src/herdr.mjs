// Opening the viewer as a pane of the Herdr tab this was called from.
//
// Every Herdr terminal belongs to its machine's core (`hc`), and a terminal labelled with a
// space and a tab shows up in that tab on every Herdr window looking at this machine: this
// Mac's, or another computer's. So the viewer is started as such a terminal, here, next to
// Chrome, and whoever has the tab open sees it.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// The new terminal runs the same node this one runs under: its PATH may not have one.
const main = fileURLToPath(new URL('./chrome-pane.mjs', import.meta.url));

function hc(args) {
  const r = spawnSync('hc', args, { encoding: 'utf8' });
  if (r.error) throw new Error('hc (herdr-core) was not found');
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `hc ${args[0]} failed`).trim());
  return r.stdout;
}

/** The space and tab of the terminal this runs in, or of the nearest parent that has them. */
export function whereAmI(env = process.env) {
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
  // The log a pane is asked to keep is asked of the pane, which is another process.
  const logs = ['CHROME_PANE_DEBUG', 'CHROME_PANE_TRACE'].filter((k) => env[k]).map((k) => `${k}=${env[k]}`);
  const out = hc(['run', '--bg', '--json', '--no-parent', '--no-notify', '--cwd', os.homedir(),
    '--label', `herdr.space=${space}`, '--label', `herdr.tab=${tab}`, '--label', 'chrome-pane=1',
    '--', ...(logs.length ? ['/usr/bin/env', ...logs] : []), process.execPath, main, 'view', ...viewArgs]);
  try { return JSON.parse(out).address ?? out.trim(); } catch { return out.trim(); }
}
