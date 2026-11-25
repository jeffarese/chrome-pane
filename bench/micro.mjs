#!/usr/bin/env node
// chrome-pane alone, with no model: each task done by a fixed script of the commands an agent
// would run, timed one by one, with the size of what each one prints. It shows what the tool
// itself costs (its floor under any agent's time) and which commands to make faster or shorter.
// Run it in a terminal of Herdr, Rex or Tern: it opens a pane there, on your Chrome.
//
//   node bench/micro.mjs [--reps 5] [--tasks a,b] [--port 47813] [--out dir]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeRunTabs } from './lib/chrome.mjs';
import { startServer } from './lib/server.mjs';
import { numbers } from './lib/site.mjs';
import { TASKS, taskById } from './lib/tasks.mjs';
import { median, pct } from './report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin/chrome-pane');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const reps = Number(opt('--reps', 5));
const tasks = (opt('--tasks') ? opt('--tasks').split(',') : TASKS.map((t) => t.id)).map(taskById);
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const out = path.resolve(opt('--out', path.join(root, 'bench/results', `micro-${stamp}`)));
fs.mkdirSync(out, { recursive: true });

class Script {
  constructor() { this.steps = []; this.last = ''; }
  /** Runs one command; its output becomes the place refs are looked up in. (Not spawnSync: the test site is served by this process.) */
  async cmd(verb, ...rest) {
    const input = verb === 'batch' ? rest.pop() : undefined;
    const t = process.hrtime.bigint();
    const { code, text } = await new Promise((resolve) => {
      const p = spawn(bin, [verb, ...rest], { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      let text = '';
      p.stdout.on('data', (d) => { text += d; });
      p.stderr.on('data', (d) => { text += d; });
      if (input !== undefined) p.stdin.end(input);
      const timer = setTimeout(() => p.kill(), 60000);
      p.on('close', (code) => { clearTimeout(timer); resolve({ code, text }); });
    });
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    this.steps.push({ verb, ms, chars: text.length, lines: text.split('\n').length, ok: code === 0 });
    if (code !== 0) throw new Error(`chrome-pane ${verb} ${rest.join(' ')} → ${text.trim().split('\n')[0]}`);
    this.last = text;
    return text;
  }
  /** The ref on the first line of the last output that matches. */
  ref(re, text = this.last) {
    const line = text.split('\n').find((l) => re.test(l));
    const m = line?.match(/\b([a-z]\d+)\b/);
    if (!m) throw new Error(`no ref for ${re} in:\n${text.slice(0, 800)}`);
    return m[1];
  }
}

// What an agent that knows the page would run, task by task. Returns the reply it would give.
const FLOWS = {
  'read-order': async (s, d, url) => {
    await s.cmd('open', url);
    await s.cmd('find', d.target.id);
    return await s.cmd('read', 'table', '--table');
  },
  checkout: async (s, d, url) => {
    const w = d.who, page = await s.cmd('open', url);
    await s.cmd('fill', s.ref(/textbox "Full name"/, page), w.name);
    await s.cmd('fill', s.ref(/textbox "Email"/, page), w.email);
    await s.cmd('fill', s.ref(/textbox "Street address"/, page), w.street);
    await s.cmd('fill', s.ref(/textbox "City"/, page), w.city);
    await s.cmd('fill', s.ref(/textbox "Postcode"/, page), w.postcode);
    await s.cmd('select', s.ref(/combobox "Delivery"/, page), d.delivery === 'express' ? 'Express, next day (€9.90)' : 'Standard, 3 to 5 days (free)');
    if (d.gift) await s.cmd('check', s.ref(/checkbox "Gift wrap/, page));
    await s.cmd('click', s.ref(/button "Place order"/, page));
  },
  'shop-cart': async (s, d, url) => {
    const p = d.products.find((x) => x.sku === d.target);
    await s.cmd('open', url);
    await s.cmd('fill', s.ref(/searchbox "Search the shop"/), p.name);
    await s.cmd('press', 'Enter');
    await s.cmd('click', s.ref(new RegExp(`link "${p.name}"$`)));
    const page = s.last;
    await s.cmd('check', s.ref(new RegExp(`radio "${d.colour}"`), page));
    await s.cmd('fill', s.ref(/spinbutton "Quantity"/, page), String(d.qty));
    await s.cmd('click', s.ref(/button "Add to cart"/, page));
  },
  'async-report': async (s, d, url) => {
    const page = await s.cmd('open', url);
    await s.cmd('select', s.ref(/combobox "Period"/, page), d.period);
    await s.cmd('click', s.ref(/button "Generate report"/, page));
    await s.cmd('wait', `Sales report: ${d.period}`);
    return await s.cmd('read');
  },
  'dialog-delete': async (s, d, url) => {
    const label = d.addresses.find((a) => a.id === d.target).label;
    const lines = (await s.cmd('open', url)).split('\n');
    const at = lines.findIndex((l) => l.includes(`h2 "${label}"`));
    await s.cmd('click', s.ref(/button "Delete"/, lines.slice(at).join('\n')));
    await s.cmd('dialog', 'accept');
  },
  'long-settings': async (s, d, url) => {
    await s.cmd('open', url);
    await s.cmd('find', 'Request export');
    const page = await s.cmd('snapshot', '--in', s.ref(/region "Data export"/, await s.cmd('find', 'Data export')));
    await s.cmd('check', s.ref(new RegExp(`radio "${d.format}"`), page));
    await s.cmd('check', s.ref(/checkbox "Include archived projects"/, page));
    if (d.attachments) await s.cmd('check', s.ref(/checkbox "Include attachments"/, page));
    await s.cmd('click', s.ref(/button "Request export"/, page));
  },
  paginated: async (s, d, url) => {
    const page = await s.cmd('open', url);
    await s.cmd('select', s.ref(/combobox "Status"/, page), 'Refunded');
    await s.cmd('click', s.ref(/button "Filter"/, page));
    const rows = (await s.cmd('read', 'table', '--table')).split('\n').filter((l) => /Refunded/.test(l));
    return `ANSWER: ${rows.length}; ${rows.reduce((n, l) => n + numbers(l).pop(), 0).toFixed(2)}`;
  },
  'custom-widgets': async (s, d, url) => {
    const page = await s.cmd('open', url);
    await s.cmd('click', s.ref(/"Normal ▾"/, await s.cmd('find', 'Normal ▾')));
    await s.cmd('click', s.ref(new RegExp(`"${d.priority}"`), await s.cmd('find', d.priority)));
    await s.cmd('fill', s.ref(/textbox "Type a name/, page), d.assignee.split(' ')[0]);
    await s.cmd('press', 'Enter');
    await s.cmd('click', s.ref(/"Save changes"/, await s.cmd('find', 'Save changes')));
  },
};

const server = await startServer({ port: Number(opt('--port', 47813)) });
const rows = [];
console.log(`chrome-pane micro-benchmark, ${reps} rounds, into ${out}`);
for (let rep = 1; rep <= reps; rep++) {
  for (const task of tasks) {
    const run = server.createRun(`micro-${task.id}-${rep}`, task.id, rep);
    const s = new Script();
    const t0 = process.hrtime.bigint();
    let reply = '', error = null;
    try { reply = (await FLOWS[task.id](s, run.data, run.url)) ?? ''; } catch (e) { error = e.message; }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const check = error ? { pass: false, reason: error } : task.verify(run, reply);
    rows.push({ task: task.id, rep, ms, pass: check.pass, reason: check.reason, steps: s.steps });
    console.log(`${check.pass ? '✓' : '✗'} ${task.id.padEnd(15)} #${rep} ${(ms / 1000).toFixed(2)} s, ${s.steps.length} commands, ${s.steps.reduce((n, x) => n + x.chars, 0)} chars${check.pass ? '' : `  ${check.reason.split('\n')[0]}`}`);
    await closeRunTabs(server.origin);
  }
}
spawnSync(bin, ['done']);
await server.close();

fs.writeFileSync(path.join(out, 'micro.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const steps = rows.flatMap((r) => r.steps);
const verbs = [...new Set(steps.map((x) => x.verb))].sort();
const f = (ms) => (ms == null ? '–' : `${Math.round(ms)} ms`);
const md = [`# chrome-pane micro-benchmark: ${path.basename(out)}`, '', `${reps} rounds. Each command is a process of its own, timed from start to exit. Tokens are about chars / 4.`, '',
  '| command | runs | median | p90 | median output | ~tokens |', '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...verbs.map((v) => { const xs = steps.filter((x) => x.verb === v); const c = median(xs.map((x) => x.chars)); return `| ${v} | ${xs.length} | ${f(median(xs.map((x) => x.ms)))} | ${f(pct(xs.map((x) => x.ms), 90))} | ${c} chars | ${Math.round(c / 4)} |`; }),
  '', '| task | passed | median time | commands | output, all commands |', '| --- | ---: | ---: | ---: | ---: |',
  ...tasks.map((t) => { const xs = rows.filter((r) => r.task === t.id); return `| ${t.id} | ${xs.filter((r) => r.pass).length}/${xs.length} | ${f(median(xs.map((r) => r.ms)))} | ${median(xs.map((r) => r.steps.length))} | ${median(xs.map((r) => r.steps.reduce((n, x) => n + x.chars, 0)))} chars |`; }),
].join('\n');
fs.writeFileSync(path.join(out, 'micro.md'), md + '\n');
console.log(`\n${md}`);
