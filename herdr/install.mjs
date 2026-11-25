#!/usr/bin/env node
// Tells a Herdr app how to show the viewer: the name "Chrome" and its icon, in programs.json,
// and a pane header that draws Chrome's controls (mods/chrome-pane), so the viewer needs no bar
// of its own. The app that draws the window decides this, so run it on each computer you sit at.
//   node herdr/install.mjs [--home <herdr-app home>] [--into <header mod>] [--remove]
// --into: a header mod of your own gets the controls' file and icons, to draw them itself.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../src/paths.mjs';

const args = process.argv.slice(2);
const at = args.indexOf('--home');
if (at >= 0 && !args[at + 1]) { console.error('--home needs the Herdr app\'s folder'); process.exit(1); }
const home = at >= 0 ? args[at + 1] : process.env.HERDR_APP_HOME || path.join(os.homedir(), '.config', 'herdr-app');
const remove = args.includes('--remove');
const to = args.indexOf('--into');
if (to >= 0 && !/^[A-Za-z0-9._-]+$/.test(args[to + 1] ?? '')) { console.error('--into needs the name of a header mod (a folder of the Herdr app\'s mods)'); process.exit(1); }
const into = to >= 0 ? args[to + 1] : null;
const from = fileURLToPath(new URL('./mod/', import.meta.url));
// The controls alone: what a header mod of someone's own draws them with.
const piece = fs.readdirSync(from).filter((f) => f === 'chrome-bar.js' || /^cp-.*\.svg$/.test(f));
if (!fs.existsSync(home)) { console.error(`no Herdr app home at ${home}`); process.exit(1); }

const file = path.join(home, 'programs.json');
let doc = {};
if (fs.existsSync(file)) {
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { console.error(`${file} is not valid JSON; fix it first`); process.exit(1); }
}
doc.programs ??= {};
const icons = path.join(home, 'icons');
if (remove) {
  delete doc.programs.chrome;
  for (const f of ['chrome.svg', 'chrome.png']) fs.rmSync(path.join(icons, f), { force: true });
} else {
  fs.mkdirSync(icons, { recursive: true });
  // Chrome's own icon, from the Chrome installed here: this repository has none of Google's
  // artwork. Without one, the plain globe that comes with this.
  const icns = '/Applications/Google Chrome.app/Contents/Resources/app.icns';
  const pngs = ['google-chrome', 'chromium', 'chromium-browser'].map((n) => `/usr/share/icons/hicolor/128x128/apps/${n}.png`);
  const out = path.join(icons, 'chrome.png');
  let icon = 'icons/chrome.svg';
  if (process.platform === 'darwin' && fs.existsSync(icns)
    && spawnSync('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '128', icns, '--out', out]).status === 0) icon = 'icons/chrome.png';
  else if (pngs.some((f) => { try { fs.copyFileSync(f, out); return true; } catch { return false; } })) icon = 'icons/chrome.png';
  else fs.copyFileSync(fileURLToPath(new URL('./chrome.svg', import.meta.url)), path.join(icons, 'chrome.svg'));
  doc.programs.chrome = { name: 'Chrome', icon, tint: false, match: ['chrome-pane'] };
}
fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
console.log(`${remove ? 'Removed Chrome from' : 'Added Chrome to'} ${file}`);

// The pane header. main.js goes last: the app loads a mod again when it changes, and must
// then find the file it imports.
const mods = path.join(home, 'mods');
const own = path.join(mods, 'chrome-pane');
if (remove) {
  fs.rmSync(own, { recursive: true, force: true });
  // No header draws the controls any more: a new pane starts with its own bar at once.
  fs.rmSync(path.join(stateDir(), 'drawn-by-herdr'), { force: true });
  if (into) for (const f of piece) fs.rmSync(path.join(mods, into, f), { force: true });
  console.log(`Removed the pane header ${own}${into ? ` and the controls from ${path.join(mods, into)}` : ''}. Point your layouts' pane header at another mod.`);
} else if (fs.existsSync(mods)) {
  fs.mkdirSync(own, { recursive: true });
  // Not what the Herdr app writes beside a mod it checks (its types, for an editor).
  const files = fs.readdirSync(from).filter((f) => f !== 'main.js' && f !== 'jsconfig.json' && !f.endsWith('.d.ts'));
  for (const f of [...files, 'main.js']) fs.copyFileSync(path.join(from, f), path.join(own, f));
  console.log(`Installed the pane header ${own}. A layout uses it as its pane header (layouts/<name>.json, in { "tab": "active" }):
  "pane": { "header": { "content": { "mod": "chrome-pane" }, "height": 30, "position": "top" } }`);
  if (into) {
    const dir = path.join(mods, into);
    if (!fs.existsSync(dir)) { console.error(`no mod ${dir}`); process.exit(1); }
    for (const f of piece) fs.copyFileSync(path.join(from, f), path.join(dir, f));
    console.log(`Put the controls in ${dir}: chrome-bar.js says how its main.js draws them.`);
  }
}
