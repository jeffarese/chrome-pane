// What viewers and agents tell each other, as small files in the state folder.
//
// A viewer writes which tab it shows (panes/<its pid>.json), so that an agent's command, which
// is another process, knows the tab of the pane beside it. An agent writes what it is doing to a
// tab (agent/<tab>.json), which the viewers of that tab show in their bar. Files, not messages
// through the bridge: the bridge holds the one connection Chrome approved, and changing what it
// does would mean restarting it and asking the person to approve again.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.mjs';

const dirOf = (name) => path.join(stateDir(), name);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/**
 * This viewer shows that tab (targetId: null while it shows none). `where`: its Herdr space, tab
 * and terminal, if any. `dialog`: the alert or question the page stopped at, if it did.
 */
export function registerPane(targetId, where = {}, dialog = null) {
  writeJson(path.join(dirOf('panes'), `${process.pid}.json`), { pid: process.pid, targetId, at: Date.now(), ...where, dialog });
}

export function unregisterPane() {
  try { fs.unlinkSync(path.join(dirOf('panes'), `${process.pid}.json`)); } catch {}
}

/** The running viewers that show a tab, the one that changed tab last first. */
export function listPanes() {
  let names = [];
  try { names = fs.readdirSync(dirOf('panes')); } catch {}
  const panes = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dirOf('panes'), name);
    const p = readJson(file);
    if (!p || !alive(p.pid)) { try { fs.unlinkSync(file); } catch {} continue; }
    if (p.targetId) panes.push(p);
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

/** Per tab, the document its refs were given for: { loaderId, gen }. */
export const readDoc = (targetId) => readJson(path.join(dirOf('docs'), `${safe(targetId)}.json`));
export const writeDoc = (targetId, doc) => writeJson(path.join(dirOf('docs'), `${safe(targetId)}.json`), doc);
