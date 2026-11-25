#!/usr/bin/env node
// Runs the browser benchmark: every method on every task, a few rounds, one headless Claude Code
// run each, one at a time on the same Chrome. See bench/README.md.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromeVersion, closeRunTabs } from './lib/chrome.mjs';
import { COMMON, METHODS, claudeVersion } from './lib/methods.mjs';
import { startServer } from './lib/server.mjs';
import { rng, shuffle } from './lib/site.mjs';
import { TASKS, taskById } from './lib/tasks.mjs';
import { analyze, stripImages } from './lib/transcript.mjs';
import { writeReport } from './report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `node bench/run.mjs [options]

  --methods a,b      ${Object.keys(METHODS).join(', ')} (default: all)
  --tasks a,b        ${TASKS.map((t) => t.id).join(', ')} (default: all)
  --reps n           rounds of every task and method (default 3)
  --model m          (default claude-opus-5-5)
  --effort level     passed to claude --effort (default: the CLI's own)
  --timeout s        a run's limit in seconds (default 480)
  --max-turns n      (default 60)
  --runner r         agp or claude (default agp when it is installed)
  --out dir          (default bench/results/<date-time>)
  --port n           the test site's port (default 47811)
  --latency ms       every answer of the test site comes this late, give or take 30% (default 0)
  --order-seed s     the seed that shuffles the methods within a round
  --no-warmup        skip the unmeasured warm-up run of each method
  --dry-run          print the plan and the first run's command, run nothing
  --serve            only serve the test site, and print a page of each task to try by hand`;

function parseArgs(argv) {
  const o = { reps: 3, model: 'claude-opus-5-5', timeout: 480, maxTurns: 60, port: 47811, warmup: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    switch (a) {
      case '--methods': o.methods = next().split(','); break;
      case '--tasks': o.tasks = next().split(','); break;
      case '--reps': o.reps = Number(next()); break;
      case '--model': o.model = next(); break;
      case '--effort': o.effort = next(); break;
      case '--timeout': o.timeout = Number(next()); break;
      case '--max-turns': o.maxTurns = Number(next()); break;
      case '--runner': o.runner = next(); break;
      case '--out': o.out = next(); break;
      case '--port': o.port = Number(next()); break;
      case '--latency': o.latency = Number(next()); break;
      case '--order-seed': o.orderSeed = next(); break;
      case '--no-warmup': o.warmup = false; break;
      case '--dry-run': o.dryRun = true; break;
      case '--serve': o.serve = true; break;
      case '-h': case '--help': console.log(HELP); process.exit(0); break;
      default: console.error(`unknown option ${a}\n\n${HELP}`); process.exit(2);
    }
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const methods = opts.methods ?? Object.keys(METHODS);
for (const m of methods) if (!METHODS[m]) { console.error(`no method ${m}`); process.exit(2); }
const tasks = (opts.tasks ?? TASKS.map((t) => t.id)).map((id) => taskById(id) ?? (console.error(`no task ${id}`), process.exit(2)));
const runner = opts.runner ?? (spawnSync('which', ['agp']).status === 0 ? 'agp' : 'claude');
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const out = path.resolve(opts.out ?? path.join(root, 'bench/results', stamp));

const server = await startServer({ port: opts.port, latency: opts.latency });
const { origin } = server;

if (opts.serve) {
  for (const t of [...tasks, taskById('warmup')]) {
    const run = server.createRun(`try-${t.id}`, t.id, 1);
    console.log(`${t.id.padEnd(15)} ${run.url}\n${' '.repeat(16)}${t.prompt(run.data, run.url)}`);
  }
  console.log('\nServing until Ctrl+C. The check of each run: GET', `${origin}/r/try-<task>/...`, 'then read the state printed on exit.');
  process.on('SIGINT', () => {
    for (const run of server.runs.values()) console.log(run.task.id, JSON.stringify(run.task.verify(run, '')), JSON.stringify(run.state));
    process.exit(0);
  });
  await new Promise(() => {});
}

fs.mkdirSync(path.join(out, 'runs'), { recursive: true });
const work = path.join(out, 'work');
fs.mkdirSync(work, { recursive: true });
const ctx = { root, out, origin };
for (const m of methods) METHODS[m].setup?.(ctx);

// --- the plan: rounds of tasks, the methods in a new order each time ---------------------------
const order = rng(String(opts.orderSeed ?? stamp));
const plan = [];
for (let rep = 1; rep <= opts.reps; rep++) for (const t of tasks) for (const m of shuffle(order, methods)) plan.push({ method: m, task: t, rep });

function command(method, task, run) {
  const m = METHODS[method];
  const flags = typeof m.flags === 'function' ? m.flags(ctx) : (m.flags ?? []);
  const args = [
    '-p', task.prompt(run.data, run.url),
    '--output-format', 'stream-json', '--verbose',
    '--model', opts.model,
    ...(opts.effort ? ['--effort', opts.effort] : []),
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', 'project', '--no-session-persistence',
    '--max-turns', String(opts.maxTurns),
    '--append-system-prompt', `${COMMON(origin)}\n\n${m.guide(ctx)}`,
    '--tools', m.tools.join(','),
    ...flags,
    '--allowedTools', ...m.allowed,
  ];
  const env = { ...process.env, ...(m.env?.(ctx) ?? {}), CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  return runner === 'agp' ? { cmd: 'agp', args: ['--on-limit', 'fail', ...args], env } : { cmd: 'claude', args, env };
}

if (opts.dryRun) {
  console.log(`${plan.length} runs (${methods.length} methods × ${tasks.length} tasks × ${opts.reps} rounds), into ${out}`);
  const first = plan[0], run = server.createRun('dry-run', first.task.id, first.rep);
  const c = command(first.method, first.task, run);
  console.log(`\n${first.method} on ${first.task.id}:\n${c.cmd} ${c.args.map((a) => (/^[\w@%+=:,./*()-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ')}`);
  await server.close();
  process.exit(0);
}

// --- the meta: what this was run on ------------------------------------------------------------
const meta = {
  startedAt: new Date().toISOString(), host: os.hostname(), platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpus: os.cpus()[0]?.model, node: process.version,
  claude: claudeVersion(), chrome: await chromeVersion(), runner, model: opts.model, effort: opts.effort ?? null,
  reps: opts.reps, latencyMs: opts.latency ?? 0, timeoutS: opts.timeout, maxTurns: opts.maxTurns, origin, tasks: tasks.map((t) => ({ id: t.id, category: t.category, title: t.title })), methods: {},
};
console.log(`Benchmark into ${out}\n${meta.claude} · ${meta.chrome ?? 'Chrome version unknown (no chrome-pane bridge)'} · ${opts.model}${opts.effort ? ` (${opts.effort})` : ''} · runner ${runner}`);
for (const id of [...methods]) {
  const p = METHODS[id].preflight(ctx);
  meta.methods[id] = { describe: METHODS[id].describe, version: p.version ?? null, preflight: p.detail };
  console.log(`  ${p.ok ? '✓' : '✗'} ${id}: ${p.detail}`);
  if (!p.ok) methods.splice(methods.indexOf(id), 1);
}
const writeMeta = () => fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2));
writeMeta();

// --- one run -------------------------------------------------------------------------------------
const results = fs.createWriteStream(path.join(out, 'results.jsonl'), { flags: 'a' });

async function runOne(method, task, rep, warmup = false) {
  const id = `${method.replace(/[^a-z]/g, '').slice(0, 6)}-${task.id}-${rep}-${crypto.randomBytes(2).toString('hex')}`;
  const run = server.createRun(id, task.id, rep);
  const c = command(method, task, run);
  const transcript = fs.createWriteStream(path.join(out, 'runs', `${id}.jsonl`));
  const lines = [];
  let stderr = '';
  const t0 = Date.now();
  const child = spawn(c.cmd, c.args, { cwd: work, env: c.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const t = Date.now() - t0;
    let o;
    try { o = stripImages(JSON.parse(line)); } catch { o = { type: 'raw', line: line.slice(0, 2000) }; }
    lines.push({ t, o });
    transcript.write(JSON.stringify({ t, o }) + '\n');
  });
  let timedOut = false;
  const kill = (sig) => { try { process.kill(-child.pid, sig); } catch {} };
  const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 5000).unref(); }, opts.timeout * 1000);
  const [code, signal] = await new Promise((r) => child.on('close', (...a) => r(a)));
  clearTimeout(timer);
  const wallMs = Date.now() - t0;
  transcript.end();
  if (stderr.trim()) fs.writeFileSync(path.join(out, 'runs', `${id}.err`), stderr);
  const closedTabs = await closeRunTabs(origin);
  METHODS[method].after?.(ctx);

  const m = analyze(lines);
  const check = (() => { try { return task.verify(run, m.reply); } catch (e) { return { pass: false, reason: `check failed: ${e.message}` }; } })();
  const need = METHODS[method].mcp;
  let outcome, reason = check.reason;
  if (code === 75) [outcome, reason] = ['infra', 'every account is at a limit (agp exit 75)'];
  else if (m.initMs === null) [outcome, reason] = ['infra', `claude did not start: ${stderr.trim().split('\n').pop() ?? ''}`];
  else if (need && !m.mcp.includes(`${need}:connected`)) [outcome, reason] = ['infra', `MCP server ${need} not connected (${m.mcp.join(', ') || 'none'})`];
  else if (check.pass) outcome = 'pass';
  else if (timedOut) [outcome, reason] = ['timeout', `${opts.timeout} s; ${check.reason}`];
  else if (m.subtype === 'error_max_turns') [outcome, reason] = ['max_turns', `${opts.maxTurns} turns; ${check.reason}`];
  else if (m.isError && /rate.?limit|overloaded|529|usage limit/i.test(m.reply)) [outcome, reason] = ['infra', m.reply.slice(0, 200)];
  else if (m.isError) [outcome, reason] = ['error', (m.reply || m.subtype || 'error').slice(0, 300)];
  else outcome = 'fail';

  const row = {
    id, method, task: task.id, category: task.category, rep, warmup, startedAt: new Date(t0).toISOString(),
    outcome, reason, wallMs, exitCode: code, signal, timedOut, closedTabs,
    serverFirstHitMs: run.firstHit ? run.firstHit - t0 : null,
    serverDoneMs: run.doneAt ? run.doneAt - t0 : null,
    pageLoads: run.events.filter((e) => e.method === 'GET' && !e.path.startsWith('/api')).length,
    requests: run.events.length,
    ...m,
  };
  results.write(JSON.stringify(row) + '\n');
  return row;
}

const secs = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(1)}s`);
const kTok = (n) => (n == null ? '-' : `${(n / 1000).toFixed(1)}k`);
const line = (r) => `${r.outcome === 'pass' ? '✓' : '✗'} ${r.method.padEnd(16)} ${r.task.padEnd(15)} #${r.rep} ${secs(r.wallMs).padStart(7)} ${String(r.turns).padStart(3)} turns ${String(r.browserCalls).padStart(3)} calls ${kTok(r.totalIn).padStart(7)} in ${kTok(r.usage.output).padStart(6)} out ${r.costUsd != null ? `$${r.costUsd.toFixed(3)}` : ''}${r.outcome === 'pass' ? '' : `  ${r.outcome}: ${r.reason}`}`;

let stopping = false;
process.on('SIGINT', () => { if (stopping) process.exit(130); stopping = true; console.log('\nStopping after this run (Ctrl+C again to quit now).'); });

// --- warm-up, the rounds, and one more try for runs that never got going ------------------------
if (opts.warmup) {
  console.log('\nWarm-up (not measured):');
  for (const m of [...methods]) {
    const r = await runOne(m, taskById('warmup'), 0, true);
    console.log(`  ${line(r)}`);
    if (r.outcome === 'infra') { console.log(`  dropping ${m}: ${r.reason}`); methods.splice(methods.indexOf(m), 1); }
  }
}
const todo = plan.filter((p) => methods.includes(p.method));
console.log(`\n${todo.length} runs:`);
const retry = [];
for (const [i, p] of todo.entries()) {
  if (stopping) break;
  const r = await runOne(p.method, p.task, p.rep);
  console.log(`[${i + 1}/${todo.length}] ${line(r)}`);
  if (r.outcome === 'infra') retry.push(p);
}
for (const p of retry) {
  if (stopping) break;
  const r = await runOne(p.method, p.task, p.rep);
  console.log(`[again] ${line(r)}`);
}

meta.finishedAt = new Date().toISOString();
writeMeta();
await new Promise((r) => results.end(r));
await server.close();
const summary = writeReport(out);
console.log(`\n${summary}\nResults: ${out}/summary.md`);
