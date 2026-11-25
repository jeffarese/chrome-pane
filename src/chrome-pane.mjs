#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent, VERBS } from './agent.mjs';
import { runBridge } from './bridge.mjs';
import { connect } from './cdp.mjs';
import { openPane } from './herdr.mjs';
import { logPath, pidPath, socketPath } from './paths.mjs';
import { Viewer } from './viewer.mjs';

const HELP = `chrome-pane: your own Chrome, shown and driven in a terminal pane

Usage:
  chrome-pane [url]            show a Chrome tab: a new one at url, or pick one of the open tabs
  chrome-pane view [url]       the same, always in this terminal
  chrome-pane tabs [--json]    list Chrome's tabs
  chrome-pane status           is the bridge to Chrome running
  chrome-pane stop             stop the bridge
  chrome-pane bridge           run the bridge in the foreground (viewers start it themselves)
  chrome-pane herdr [--remove] give this computer's Herdr app the name and icon for it
  chrome-pane skill [install|remove]   print the agent skill; link it where Claude Code and Codex look

For agents (they act on the tab the pane of their Herdr tab shows, and answer in text):
  chrome-pane open <url>       go there (opens the pane if there is none); prints the page
  chrome-pane snapshot         the controls in view, each with a ref (--all, --in <ref>, --text, --urls)
  chrome-pane find <text>      where on the page that is (--role <role>)
  chrome-pane read [ref|css]   the main text, or one part's (--table, --from <n>)
  chrome-pane click|hover|check|uncheck <ref>, fill <ref> <text>, select <ref> <option>,
              type <text>, press <keys>, scroll [down|up|top|bottom|ref], back, forward, reload
                               one action; prints what changed
  chrome-pane wait <text>      until it is on the page (--gone <text>, --url <part>, --idle, --timeout <s>)
  chrome-pane batch            one action per line on its input
  chrome-pane shot             a picture of the view, into a file (--scale <n>, --png, --out <file>)
  chrome-pane eval <js>, dialog accept|dismiss, done

In a terminal, the tab is shown there. Called by a program with no terminal (an agent) inside
Herdr, or with --pane, it opens as a new pane of the Herdr tab it was called from.

Options:
  --tab <text>           show the open tab whose title or address has this text
  --pane                 open as a new pane of this Herdr tab, even from a terminal
  --mirror               keep the size the tab has in Chrome (default: fit it to the pane)
  --no-front             never bring the tab to the front in Chrome (it is not drawn while behind)
  --quality <q>          auto: half the pixels while the page moves, sharp once it rests (default);
                         sharp: every frame at full size; fast: never the sharp picture
  --scale <n>            pixels per page pixel (default: 2 on a Retina-size font, else 1)
  --fps <n>              most frames per second (default 20)
  --rate <n>             most megabytes a second of pictures (default 3; lower over a slow link)
  --whole                send every frame whole, never only the part of it that changed
  --user-data-dir <dir>  another Chromium browser's profile folder
  --idle <seconds>       bridge: stop this long after the last viewer left (default: never)

Keys in the viewer: Ctrl+T tabs, Ctrl+L address, Ctrl+R reload, Alt+←/→ back and forward,
Ctrl+Q quit. Everything else, and the mouse, goes to the page.

Chrome must allow it once: chrome://inspect/#remote-debugging, then accept its prompt.`;

function parse(argv) {
  const o = { _: [] };
  const flags = new Set(['mirror', 'json', 'pane', 'help', 'no-front', 'whole']);
  const values = { quality: String, tab: String, scale: Number, fps: Number, rate: Number, 'user-data-dir': String, idle: Number, socket: String };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { o.help = true; continue; }
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const name = a.slice(2);
    if (flags.has(name)) o[name] = true;
    else if (name in values) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      o[name === 'user-data-dir' ? 'userDataDir' : name] = values[name](v);
      if (values[name] === Number && !(o[name] >= 0)) throw new Error(`${a} needs a number`);
    } else throw new Error(`unknown option ${a} (chrome-pane --help)`);
  }
  return o;
}

/** `skill` prints the agent skill; `skill install` links it into each folder an agent reads skills from. */
function skill(argv) {
  const dir = fileURLToPath(new URL('../skills/chrome-pane', import.meta.url));
  if (!argv[0]) return process.stdout.write(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
  if (argv[0] !== 'install' && argv[0] !== 'remove') throw new Error('chrome-pane skill, skill install or skill remove');
  // Claude Code (every account folder here shares ~/.claude/skills), the agents standard, Codex.
  for (const home of ['.claude', '.agents', '.codex']) {
    const skills = path.join(os.homedir(), home, 'skills'), link = path.join(skills, 'chrome-pane');
    if (!fs.existsSync(path.join(os.homedir(), home))) continue;
    let now = null;
    try { now = fs.lstatSync(link); } catch {}
    if (now && !now.isSymbolicLink()) { console.log(`${link} is not a link: left as it is`); continue; }
    if (now) fs.unlinkSync(link);
    if (argv[0] === 'install') { fs.mkdirSync(skills, { recursive: true }); fs.symlinkSync(dir, link); console.log(`linked ${link}`); }
    else if (now) console.log(`removed ${link}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (VERBS.has(argv[0])) {
    const code = await runAgent(argv[0], argv.slice(1));
    // Leaves once what it said is written: a pipe takes a long answer in pieces.
    return void process.stdout.write('', () => process.exit(code));
  }
  const commands = new Set(['view', 'tabs', 'status', 'stop', 'bridge', 'herdr', 'skill', 'help']);
  const cmd = commands.has(argv[0]) ? argv.shift() : null;
  if (cmd === 'skill') return skill(argv);
  if (cmd === 'herdr') {
    // The name and icon are the Herdr app's to keep: herdr/install.mjs writes them in its programs.json.
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../herdr/install.mjs', import.meta.url)), ...argv], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  const o = parse(argv);
  if (o.help || cmd === 'help') return console.log(HELP);

  if (cmd === 'bridge') return runBridge(o);

  if (cmd === 'status' || cmd === 'stop') {
    let pid = null;
    try { pid = Number(fs.readFileSync(pidPath(), 'utf8')); process.kill(pid, 0); } catch { pid = null; }
    if (!pid) return console.log('The bridge is not running.');
    if (cmd === 'status') return console.log(`The bridge is running (pid ${pid}, socket ${socketPath()}, log ${logPath()}).`);
    process.kill(pid, 'SIGTERM');
    return console.log('Stopped the bridge.');
  }

  if (cmd === 'tabs') {
    const cdp = await connect(o);
    if (cdp.state === 'waiting') console.error('Waiting for Chrome: accept its “Allow remote debugging?” prompt.');
    await cdp.ready();
    const { targetInfos } = await cdp.send('Target.getTargets');
    const pages = targetInfos.filter((t) => t.type === 'page' && !/^(devtools|chrome-extension|chrome-untrusted):/.test(t.url));
    if (o.json) console.log(JSON.stringify(pages.map(({ targetId, title, url }) => ({ id: targetId, title, url })), null, 2));
    else for (const t of pages) console.log(`${t.title || '(untitled)'}\n  ${t.url}`);
    cdp.close();
    return;
  }

  if (o.quality && !['auto', 'sharp', 'fast'].includes(o.quality)) throw new Error('--quality is auto, sharp or fast');
  const view = { url: o._[0], tab: o.tab, front: !o['no-front'], quality: o.quality, mirror: o.mirror, scale: o.scale, fps: o.fps, rate: o.rate, parts: !o.whole, userDataDir: o.userDataDir, socket: o.socket };
  if (cmd !== 'view' && (o.pane || !process.stdin.isTTY || !process.stdout.isTTY)) {
    // With no terminal a word that is no address is a mistyped command, not something to search for.
    if (view.url && !/[.:/]/.test(view.url) && view.url !== 'localhost') throw new Error(`unknown command ${view.url} (chrome-pane --help)`);
    const pass = [];
    if (view.url) pass.push(view.url);
    for (const [k, flag] of [['quality', '--quality'], ['tab', '--tab'], ['scale', '--scale'], ['fps', '--fps'], ['rate', '--rate'], ['userDataDir', '--user-data-dir'], ['socket', '--socket']]) if (view[k] !== undefined) pass.push(flag, String(view[k]));
    if (view.mirror) pass.push('--mirror');
    if (!view.parts) pass.push('--whole');
    if (!view.front) pass.push('--no-front');
    const address = openPane(pass);
    return console.log(`Chrome opened as a pane of this Herdr tab (terminal ${address}).`);
  }
  await new Viewer(view).run();
}

main().catch((e) => { console.error(`chrome-pane: ${e.message}`); process.exit(1); });
