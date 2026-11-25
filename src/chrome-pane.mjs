#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent, VERBS } from './agent.mjs';
import { BRIDGE, canConnect, runBridge } from './bridge.mjs';
import { connect } from './cdp.mjs';
import { hostOf } from './hosts.mjs';
import { listPanes, ours, pushAct, readBar } from './panes.mjs';
import { logPath, pidPath, socketPath } from './paths.mjs';
import { oneLine } from './util.mjs';
import { Viewer } from './viewer.mjs';

const HELP = `chrome-pane: your own Chrome, shown and driven in a terminal pane

Usage:
  chrome-pane [url]            show a Chrome tab: a new one at url, or pick one of the open tabs
  chrome-pane view [url]       the same, always in this terminal
  chrome-pane tabs [--json]    list Chrome's tabs
  chrome-pane status           is the bridge to Chrome running (exit 1 when it is not)
  chrome-pane stop             stop the bridge
  chrome-pane bridge           run the bridge in the foreground (viewers start it themselves)
  chrome-pane herdr [--remove] give this computer's Herdr app the name and icon for it, and a pane
                               header that draws the controls (--into <mod>: into a header of your own)
  chrome-pane bar              what the pane's bar says, as JSON: the page, whether it loads, what it asks
  chrome-pane bar <action>     one action of the bar, with no pane to click in: back, forward, reload,
                               stop, go <address>, tabs, page, front, dialog-ok, dialog-cancel,
                               resend-yes, resend-no (--in <terminal or pid>: of that pane)
  chrome-pane skill [install|remove]   print the agent skill; link it where Claude Code and Codex look

For agents (they act on the tab the pane of their own tab shows, and answer in text):
  chrome-pane open <url>       go there (opens the pane if there is none); prints the page
  chrome-pane snapshot         the controls in view, each with a ref (--all, --in <ref>, --text, --urls)
  chrome-pane find <text>      where on the page that is (--role <role>)
  chrome-pane read [ref|css]   the main text, or one part's (--table, --from <n>)
  chrome-pane click|hover|check|uncheck <ref>, fill <ref> <text>, select <ref> <option>,
              type <text>, press <keys>, scroll [down|up|top|bottom|ref], back, forward,
              reload [--resend] (the answer to a sent form is not sent again unasked)
                               one action; prints what changed. In place of a ref, the
                               name of the one control that has it: click "Next"
  chrome-pane wait <text>      until it is on the page (--gone <text>, --url <part>, --idle, --timeout <s>)
  chrome-pane batch            one action per line on its input
  chrome-pane shot             a picture of the view, into a file (--scale <n>, --png, --out <new file>)
  chrome-pane eval <js>, dialog accept|dismiss, done

In a terminal, the tab is shown there. Called by a program with no terminal (an agent) inside
Herdr, Rex or Tern, or with --pane, it opens as a new pane beside the one it was called from.

Options:
  --tab <text>           show the open tab whose title or address has this text
  --pane                 open as a new pane of this tab of Herdr, Rex or Tern, even from a terminal
  --mirror               keep the size the tab has in Chrome (default: fit it to the pane)
  --no-front             never bring the tab to the front in Chrome (it is not drawn while behind)
  --bar                  keep the viewer's own bar, even where Herdr's pane header draws the controls
  --quality <q>          auto: half the pixels while the page moves, sharp once it rests (default);
                         sharp: every frame at full size; fast: never the sharp picture
  --scale <n>            pixels per page pixel (default: 2 on a Retina-size font, else 1)
  --fps <n>              most frames per second (default 20)
  --rate <n>             most megabytes a second of pictures (default 3; lower over a slow link)
  --whole                send every frame whole, never only the part of it that changed
  --user-data-dir <dir>  another Chromium browser's profile folder
  --idle <seconds>       bridge: stop this long after the last viewer left (default: never)
  --version, --help

Keys in the viewer: Ctrl+T tabs, Ctrl+L address, Ctrl+R reload, Alt+←/→ back and forward,
Ctrl+Q quit. Everything else, and the mouse, goes to the page (Ctrl+C copies there). The bar's
buttons take clicks: back, forward, reload or stop, the address, the tabs.

Chrome must allow it once: chrome://inspect/#remote-debugging, then accept its prompt.`;

function parse(argv) {
  const o = { _: [] };
  const flags = new Set(['mirror', 'json', 'pane', 'help', 'no-front', 'whole', 'bar']);
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
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error(`Node 22 or newer is needed, and this is Node ${process.versions.node} (${process.execPath}). CHROME_PANE_NODE names another.`);
  }
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    return console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  }
  const asksHelp = (args) => { const end = args.indexOf('--'); return (end < 0 ? args : args.slice(0, end)).some((a) => a === '--help' || a === '-h'); };
  if (VERBS.has(argv[0])) {
    if (asksHelp(argv)) return console.log(HELP);
    // What reads the answer may stop reading (`| head -3`): the actions asked for are done all
    // the same, not left halfway where the reader stopped.
    process.stdout.on('error', () => {});
    const code = await runAgent(argv[0], argv.slice(1));
    // Leaves once what it said is written: a pipe takes a long answer in pieces.
    if (process.stdout.destroyed || process.stdout.writableEnded) process.exit(code);
    return void process.stdout.write('', () => process.exit(code));
  }
  const commands = new Set(['view', 'tabs', 'status', 'stop', 'bridge', 'herdr', 'skill', 'help', 'bar']);
  const cmd = commands.has(argv[0]) ? argv.shift() : null;
  if (cmd === 'skill') return skill(argv);
  if (cmd === 'bar') {
    // The bar with no terminal to look at: what it says, or one of its actions, as a click on it
    // would. The controls a multiplexer draws for a pane (Herdr's pane header) work through this.
    if (asksHelp(argv)) return console.log('chrome-pane bar [--in <the pane\'s terminal, or its viewer\'s pid>] [<action> [value]]\n  Without an action: what the bar says, as JSON. Actions: back, forward, reload, stop, go <address>, tabs, page,\n  front, address, dialog-ok, dialog-cancel, resend-yes, resend-no, and for Chrome\'s other tabs (their ids:\n  chrome-pane tabs --json): show <id>, close-tab <id>, new [address].');
    const rest = [];
    let id = null;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--in') { id = argv[++i]; if (!id) throw new Error('--in needs the pane\'s terminal, or its viewer\'s pid'); }
      else if (argv[i] !== '--json') rest.push(argv[i]);
    }
    let panes = listPanes({ all: true });
    if (id) panes = panes.filter((p) => String(p.pid) === id || p.terminal === id);
    else { const host = hostOf(); if (host) try { panes = host.panes(panes, process.env); } catch {} }
    if (!panes.length) throw new Error(id ? `no Chrome pane runs in ${id}` : 'there is no Chrome pane here (chrome-pane bar --in <terminal or pid>: of another tab)');
    const [act, ...value] = rest;
    if (act) return pushAct(panes[0].pid, act, value.length ? value.join(' ') : null);
    const { cli, ...said } = readBar(panes[0].pid) ?? {};
    return console.log(JSON.stringify({ terminal: panes[0].terminal ?? null, ...said }, null, 2));
  }
  if (cmd === 'herdr') {
    if (asksHelp(argv)) return console.log('chrome-pane herdr [--home <the Herdr app\'s folder>] [--into <header mod>] [--remove]\n  Gives the Herdr app on this computer the name and icon for the pane (in its programs.json) and a pane\n  header that draws Chrome\'s controls (mods/chrome-pane), or takes them out.\n  --into: a header mod of your own gets the controls\' file and icons, to draw them itself.');
    // The name, the icon and the pane header are the Herdr app's to keep: herdr/install.mjs puts them there.
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../herdr/install.mjs', import.meta.url)), ...argv], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  const o = parse(argv);
  if (o.help || cmd === 'help') return console.log(HELP);

  if (cmd === 'bridge') return runBridge(o);

  if (cmd === 'status' || cmd === 'stop') {
    // The pid in the file is a bridge's only if that process is one: a file outlives its bridge
    // (a kill, a power cut), and the number may be some other program's by now.
    let pid = null;
    try { pid = Number(fs.readFileSync(pidPath(), 'utf8')); } catch {}
    if (!ours(pid, BRIDGE)) {
      console.log('The bridge is not running.');
      if (cmd === 'status') process.exitCode = 1;
      return;
    }
    if (cmd === 'status') {
      const answers = await canConnect(o.socket || socketPath());
      return console.log(`The bridge is running (pid ${pid}, socket ${socketPath()}, log ${logPath()}).${answers ? '' : ' Its socket does not answer: chrome-pane stop, then open a pane again.'}`);
    }
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
    else for (const t of pages) console.log(`${oneLine(t.title) || '(untitled)'}\n  ${oneLine(t.url)}`);
    cdp.close();
    return;
  }

  if (o.quality && !['auto', 'sharp', 'fast'].includes(o.quality)) throw new Error('--quality is auto, sharp or fast');
  const view = { url: o._[0], tab: o.tab, front: !o['no-front'], quality: o.quality, mirror: o.mirror, scale: o.scale, fps: o.fps, rate: o.rate, parts: !o.whole, bar: o.bar, userDataDir: o.userDataDir, socket: o.socket };
  // A lone word that is no address is a mistyped command, not something to search the web for.
  if (cmd !== 'view' && view.url && !/[.:/\s]/.test(view.url) && view.url !== 'localhost') {
    throw new Error(`unknown command ${view.url} (chrome-pane --help; to search for it: chrome-pane view ${view.url})`);
  }
  if (cmd !== 'view' && (o.pane || !process.stdin.isTTY || !process.stdout.isTTY)) {
    const pass = [];
    if (view.url) pass.push(view.url);
    for (const [k, flag] of [['quality', '--quality'], ['tab', '--tab'], ['scale', '--scale'], ['fps', '--fps'], ['rate', '--rate'], ['userDataDir', '--user-data-dir'], ['socket', '--socket']]) if (view[k] !== undefined) pass.push(flag, String(view[k]));
    if (view.mirror) pass.push('--mirror');
    if (!view.parts) pass.push('--whole');
    if (!view.front) pass.push('--no-front');
    if (view.bar) pass.push('--bar');
    const host = hostOf();
    if (!host) throw new Error('this is not a terminal of Herdr, Rex or Tern to open a pane in: run chrome-pane in a terminal to view there');
    // A person who asked for the pane is about to use it; an agent's stays out of its way.
    const { terminal } = host.open(pass, process.env, { focus: Boolean(o.pane && process.stdin.isTTY) });
    return console.log(`Chrome opened as a pane of this ${host.name} tab (${terminal}).`);
  }
  await new Viewer(view).run();
}

main().catch((e) => { console.error(`chrome-pane: ${e.message}`); process.exit(1); });
