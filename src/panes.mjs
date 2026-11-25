// What viewers and agents tell each other, as small files in the state folder.
//
// A viewer writes which tab it shows (panes/<its pid>.json), so that an agent's command, which
// is another process, knows the tab of the pane beside it. An agent writes what it is doing to a
// tab (agent/<tab>.json), which the viewers of that tab show in their bar. Files, not messages
// through the bridge: the bridge holds the one connection Chrome approved, and changing what it
// does would mean restarting it and asking the person to approve again.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.mjs';

const dirOf = (name) => path.join(stateDir(), name);

/**
 * Is the process with that pid one of chrome-pane's? A pid stays in a file after its process
 * died (a kill, a power cut), and the system then gives the number to some other program.
 */
export function ours(pid, word = 'chrome-pane') {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch { return false; }
  const r = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  if (r.error) return true; // no ps to ask: the pid is alive, which is all there is to know
  return r.status === 0 && r.stdout.includes(word);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/**
 * This viewer shows that tab (targetId: null while it shows none). `where`: its Herdr space, tab
 * and terminal, if any. `dialog`: the alert or question the page stopped at, if it did. `posted`:
 * the page is the answer to a form that was sent, so a reload would send the form again.
 */
export function registerPane(targetId, where = {}, dialog = null, at = Date.now(), posted = false) {
  writeJson(path.join(dirOf('panes'), `${process.pid}.json`), { pid: process.pid, targetId, at, ...where, dialog, ...(posted ? { posted: true } : {}) });
}

export function unregisterPane() {
  try { fs.unlinkSync(path.join(dirOf('panes'), `${process.pid}.json`)); } catch {}
  try { fs.unlinkSync(barFile(process.pid)); } catch {}
}

/**
 * What a viewer's bar says (the page, whether it loads, what it asks), as the JSON text the
 * viewer keeps up to date: `chrome-pane bar` prints it, with no pane to look at.
 */
const barFile = (pid) => path.join(dirOf('agent'), `pane-${pid}.bar.json`);
export function writeBar(text) {
  const file = barFile(process.pid);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
export const readBar = (pid) => readJson(barFile(pid));

/** The running viewers that show a tab (`all`: those that show none yet, too), the one that changed tab last first. */
export function listPanes({ all = false } = {}) {
  let names = [];
  try { names = fs.readdirSync(dirOf('panes')); } catch {}
  const panes = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dirOf('panes'), name);
    const p = readJson(file);
    if (!p || !ours(p.pid)) { try { fs.unlinkSync(file); } catch {} continue; }
    if (p.targetId || all) panes.push(p);
  }
  return panes.sort((a, b) => b.at - a.at);
}

const safe = (targetId) => String(targetId).replace(/[^A-Za-z0-9_-]/g, '');
export const notesDir = () => dirOf('agent');

/** What an agent is doing to a tab, for the viewers' bar; null when it is done. */
export function writeNote(targetId, text) {
  const file = path.join(notesDir(), `${safe(targetId)}.json`);
  if (text === null) { try { fs.unlinkSync(file); } catch {} return; }
  writeJson(file, { text, at: Date.now() });
}

export const readNote = (targetId) => readJson(path.join(notesDir(), `${safe(targetId)}.json`));

/**
 * What an agent asks the viewer of a tab to do for it: answer the page's dialog. Chrome lets
 * only a connection that was there when the dialog opened answer it, and an agent's command
 * connects anew each time; the viewer's stays. { dialog: { accept, text } }, or null to take it back.
 */
export function writeAsk(targetId, ask) {
  const file = path.join(notesDir(), `${safe(targetId)}.ask.json`);
  if (ask === null) { try { fs.unlinkSync(file); } catch {} return; }
  writeJson(file, { ...ask, at: Date.now() });
}
export const readAsk = (targetId) => readJson(path.join(notesDir(), `${safe(targetId)}.ask.json`));

/**
 * What the controls a multiplexer draws for a pane (Herdr's pane header) ask its viewer to do:
 * { act, arg }, as a click on the viewer's own bar would. One file each, taken in the order
 * they were asked: two clicks in a row are two actions.
 */
let asked = 0;
export function pushAct(pid, act, arg = null) {
  writeJson(path.join(notesDir(), `pane-${pid}.${Date.now()}-${process.pid}-${asked++}.act.json`), { act, arg, at: Date.now() });
}
export function takeActs(pid = process.pid) {
  let names = [];
  try { names = fs.readdirSync(notesDir()); } catch {}
  const acts = [];
  for (const name of names.filter((n) => n.startsWith(`pane-${pid}.`) && n.endsWith('.act.json')).sort()) {
    const file = path.join(notesDir(), name);
    const a = readJson(file);
    try { fs.unlinkSync(file); } catch {}
    // One that waited: asked of a viewer that was not there to hear it.
    if (a && typeof a.act === 'string' && Date.now() - a.at < 15000) acts.push(a);
  }
  return acts;
}

/**
 * Whether the multiplexer of that name drew the controls itself for a pane within the last
 * hour (its header says so every half minute): a new pane then starts without a bar of its
 * own, and puts one up if nothing claims it. Older than that, the header may be gone for good.
 */
const drawnFile = (host) => path.join(stateDir(), `drawn-by-${safe(host)}`);
export function drawnBy(host, now = Date.now()) {
  try { return now - fs.statSync(drawnFile(host)).mtimeMs < 3600000; } catch { return false; }
}
export function setDrawnBy(host, drawn) {
  try {
    if (drawn) { fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 }); fs.writeFileSync(drawnFile(host), '', { mode: 0o600 }); }
    else fs.unlinkSync(drawnFile(host));
  } catch {}
}

/**
 * What a tab showed before the action that stopped its page at a dialog: the command that
 * answers the dialog tells the outcome against it. null to take it back.
 */
export function writeBefore(targetId, before) {
  const file = path.join(notesDir(), `${safe(targetId)}.before.json`);
  if (before === null) { try { fs.unlinkSync(file); } catch {} return; }
  writeJson(file, { ...before, at: Date.now() });
}
export const readBefore = (targetId) => readJson(path.join(notesDir(), `${safe(targetId)}.before.json`));

/** Per tab, the document its refs were given for: { loaderId, gen }. */
export const readDoc = (targetId) => readJson(path.join(dirOf('docs'), `${safe(targetId)}.json`));
export function writeDoc(targetId, doc) {
  writeJson(path.join(dirOf('docs'), `${safe(targetId)}.json`), doc);
  // Tabs close without anyone telling: what was kept about one a week ago is of no use.
  for (const dir of [dirOf('docs'), notesDir()]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const name of names) {
      const file = path.join(dir, name);
      try { if (Date.now() - fs.statSync(file).mtimeMs > 7 * 86400000) fs.unlinkSync(file); } catch {}
    }
  }
}
