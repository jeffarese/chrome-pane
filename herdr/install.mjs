#!/usr/bin/env node
// Tells a Herdr app how to show the viewer: the name "Chrome" and its icon, in programs.json.
// The app that draws the window decides this, so run it on each computer you sit at.
//   node herdr/install.mjs [--home <herdr-app home>] [--remove]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const at = args.indexOf('--home');
if (at >= 0 && !args[at + 1]) { console.error('--home needs the Herdr app\'s folder'); process.exit(1); }
const home = at >= 0 ? args[at + 1] : process.env.HERDR_APP_HOME || path.join(os.homedir(), '.config', 'herdr-app');
const remove = args.includes('--remove');
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
