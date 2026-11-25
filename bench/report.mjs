#!/usr/bin/env node
// The summary of a benchmark's results, and the comparison of two benchmarks.
//
//   node bench/report.mjs <results dir>                  writes summary.md and summary.json there
//   node bench/report.mjs <results dir> <baseline dir>   also compares it with an earlier run
//   ... --reanalyze                                      measures every run again from its transcript
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from './lib/transcript.mjs';

const sorted = (xs) => xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
export function median(xs) { const s = sorted(xs); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
export function pct(xs, p) { const s = sorted(xs); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null; }
const sum = (xs) => xs.reduce((n, x) => n + (x || 0), 0);
const mean = (xs) => { const s = sorted(xs); return s.length ? sum(s) / s.length : null; };
const by = (rows, key) => { const g = new Map(); for (const r of rows) { const k = key(r); if (!g.has(k)) g.set(k, []); g.get(k).push(r); } return g; };

const s1 = (ms) => (ms == null ? '–' : `${(ms / 1000).toFixed(1)} s`);
const k1 = (n) => (n == null ? '–' : n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : `${(n / 1000).toFixed(1)} k`);
const usd = (n) => (n == null ? '–' : `$${n.toFixed(3)}`);
const n1 = (n) => (n == null ? '–' : Number.isInteger(n) ? String(n) : n.toFixed(1));
const rate = (p, n) => (n ? `${Math.round((100 * p) / n)}% (${p}/${n})` : '–');
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map((h, i) => (i ? '---:' : '---')).join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

/** A run's figures measured again from its transcript, by this version of the analysis. Its outcome stays. */
function reanalyzed(dir, row) {
  const file = path.join(dir, 'runs', `${row.id}.jsonl`);
  if (!fs.existsSync(file)) return row;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { ...row, ...analyze(lines) };
}

/** The rows of a results folder: the last try of each run, warm-ups and runs that never got going left out. */
export function load(dir, { reanalyze = false } = {}) {
  let rows = fs.readFileSync(path.join(dir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (reanalyze) rows = rows.map((r) => reanalyzed(dir, r));
  const meta = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { return {}; } })();
  const last = new Map();
  for (const r of rows) {
    const k = `${r.method}|${r.task}|${r.rep}|${r.warmup}`;
    const prev = last.get(k);
    if (!prev || prev.outcome === 'infra' || r.outcome !== 'infra') last.set(k, r);
  }
  const all = [...last.values()];
  return { meta, rows: all.filter((r) => !r.warmup && r.outcome !== 'infra'), infra: all.filter((r) => r.outcome === 'infra'), warmups: all.filter((r) => r.warmup) };
}

/** The figures of a group of runs. */
export function stats(rows) {
  const pass = rows.filter((r) => r.outcome === 'pass');
  const cost = sum(rows.map((r) => r.costUsd));
  const model = sum(rows.map((r) => r.modelMs)), tools = sum(rows.map((r) => r.toolMs));
  return {
    runs: rows.length, passes: pass.length, passRate: rows.length ? pass.length / rows.length : null,
    wall: median(rows.map((r) => r.wallMs)), wallP90: pct(rows.map((r) => r.wallMs), 90), wallPass: median(pass.map((r) => r.wallMs)),
    firstHit: median(rows.map((r) => r.serverFirstHitMs)), done: median(rows.map((r) => r.serverDoneMs)),
    init: median(rows.map((r) => r.initMs)),
    turns: median(rows.map((r) => r.turns)), calls: median(rows.map((r) => r.browserCalls)),
    totalIn: median(rows.map((r) => r.totalIn)), out: median(rows.map((r) => r.usage?.output)),
    ctxFirst: median(rows.map((r) => r.ctxFirst)), ctxMax: median(rows.map((r) => r.ctxMax)),
    toolTokens: median(rows.map((r) => r.toolResultTokens)),
    images: mean(rows.map((r) => r.images)), toolErrors: mean(rows.map((r) => r.toolErrors)),
    denials: sum(rows.map((r) => r.denials?.length)),
    cost: median(rows.map((r) => r.costUsd)), costTotal: cost, costPerPass: pass.length ? cost / pass.length : null,
    modelShare: model + tools ? model / (model + tools) : null,
    toolMsPerCall: median(rows.flatMap((r) => (r.calls || []).filter((c) => c.name !== 'ToolSearch').map((c) => c.ms))),
  };
}

function toolTable(rows) {
  const calls = rows.flatMap((r) => (r.calls || []).map((c) => ({ ...c, method: r.method })));
  const groups = [...by(calls, (c) => `${c.method}|${c.name === 'Bash' ? `Bash: ${c.input.split(/\s+/).slice(0, 2).join(' ')}` : c.name}`).entries()]
    .sort(([a], [b]) => a.localeCompare(b));
  return table(['method · tool', 'calls', 'median', 'p90', 'median output', 'pictures', 'errors'],
    groups.map(([k, cs]) => [k.replace('|', ' · ').replace(/^(\S+) · mcp__[^_]+(?:-[^_]+)*__/, '$1 · '), cs.length, s1(median(cs.map((c) => c.ms))), s1(pct(cs.map((c) => c.ms), 90)), `${n1(median(cs.map((c) => c.chars)))} chars`, sum(cs.map((c) => c.images)), sum(cs.map((c) => (c.error ? 1 : 0)))]));
}

export function summarize(dir, baseDir, opts = {}) {
  const { meta, rows, infra } = load(dir, opts);
  const seen = new Set(rows.map((r) => r.method));
  const methods = [...new Set([...Object.keys(meta.methods || {}), ...seen])].filter((m) => seen.has(m));
  const tasks = [...new Set(rows.map((r) => r.task))];
  const per = Object.fromEntries(methods.map((m) => [m, stats(rows.filter((r) => r.method === m))]));
  const perTask = {};
  for (const t of tasks) for (const m of methods) perTask[`${m}|${t}`] = stats(rows.filter((r) => r.method === m && r.task === t));

  const md = [];
  md.push(`# Browser benchmark: ${path.basename(dir)}`, '');
  md.push(`${meta.claude ?? ''} · ${meta.model ?? ''}${meta.effort ? ` (${meta.effort})` : ''} · ${meta.chrome ?? ''} · ${meta.reps ?? '?'} rounds · ${meta.startedAt ?? ''}`, '');
  for (const [m, x] of Object.entries(meta.methods || {})) md.push(`- **${m}**: ${x.describe}${x.version ? ` (${x.version})` : ''}`);
  md.push('', '## By method', '');
  md.push(table(['', ...methods], [
    ['passed', ...methods.map((m) => rate(per[m].passes, per[m].runs))],
    ['time, median (p90)', ...methods.map((m) => `${s1(per[m].wall)} (${s1(per[m].wallP90)})`)],
    ['time of passed runs, median', ...methods.map((m) => s1(per[m].wallPass))],
    ['start-up (claude + tools)', ...methods.map((m) => s1(per[m].init))],
    ['first page load', ...methods.map((m) => s1(per[m].firstHit))],
    ['task done, server saw it', ...methods.map((m) => s1(per[m].done))],
    ['model share of the time', ...methods.map((m) => (per[m].modelShare == null ? '–' : `${Math.round(per[m].modelShare * 100)}%`))],
    ['browser tool call, median', ...methods.map((m) => s1(per[m].toolMsPerCall))],
    ['model calls (turns)', ...methods.map((m) => n1(per[m].turns))],
    ['browser tool calls', ...methods.map((m) => n1(per[m].calls))],
    ['input tokens, all calls', ...methods.map((m) => k1(per[m].totalIn))],
    ['output tokens', ...methods.map((m) => k1(per[m].out))],
    ['context at the first call', ...methods.map((m) => k1(per[m].ctxFirst))],
    ['context at its largest', ...methods.map((m) => k1(per[m].ctxMax))],
    ['tokens the tools returned', ...methods.map((m) => k1(per[m].toolTokens))],
    ['pictures per run', ...methods.map((m) => n1(per[m].images))],
    ['tool errors per run', ...methods.map((m) => n1(per[m].toolErrors))],
    ['refused tool calls (all runs)', ...methods.map((m) => n1(per[m].denials))],
    ['cost per run, median', ...methods.map((m) => usd(per[m].cost))],
    ['cost per passed task', ...methods.map((m) => usd(per[m].costPerPass))],
  ]));
  md.push('', 'Medians over every run of the method. Time is from starting `claude -p` to its exit. Input tokens count every call\'s whole context (cached or not), so they do not depend on what the cache held. Cost is what Claude Code reports, with the cache as it was.', '');

  md.push('## By task', '');
  md.push(table(['task', ...methods.map((m) => `${m}: passed · time · tokens in`)], tasks.map((t) => [t, ...methods.map((m) => {
    const x = perTask[`${m}|${t}`];
    return x.runs ? `${x.passes}/${x.runs} · ${s1(x.wall)} · ${k1(x.totalIn)}` : '–';
  })])));
  md.push('');

  md.push('## Tools', '', toolTable(rows), '');

  const fails = rows.filter((r) => r.outcome !== 'pass');
  md.push('## Runs that failed', '');
  md.push(fails.length ? table(['run', 'method', 'task', 'outcome', 'why'], fails.map((r) => [r.id, r.method, r.task, r.outcome, String(r.reason || '').replace(/\|/g, '/').slice(0, 160)])) : 'None.');
  if (infra.length) md.push('', `Not counted, as they never got going: ${infra.map((r) => `${r.id} (${r.reason})`).join('; ')}`);
  md.push('');

  let compare = null;
  if (baseDir) {
    const base = load(baseDir, opts);
    const bPer = (m, t) => stats(base.rows.filter((r) => r.method === m && (!t || r.task === t)));
    const d = (a, b, f) => (a == null || b == null ? '–' : `${f(b)} → ${f(a)} (${b ? `${a >= b ? '+' : ''}${Math.round(((a - b) / b) * 100)}%` : ''})`);
    md.push(`## Against ${path.basename(baseDir)}`, '');
    md.push(table(['method', 'passed', 'time', 'input tokens', 'output tokens', 'cost'], methods.map((m) => {
      const a = per[m], b = bPer(m);
      return [m, `${rate(b.passes, b.runs)} → ${rate(a.passes, a.runs)}`, d(a.wall, b.wall, s1), d(a.totalIn, b.totalIn, k1), d(a.out, b.out, k1), d(a.cost, b.cost, usd)];
    })));
    md.push('', table(['method · task', 'passed', 'time', 'input tokens'], methods.flatMap((m) => tasks.map((t) => {
      const a = perTask[`${m}|${t}`], b = bPer(m, t);
      return b.runs ? [`${m} · ${t}`, `${b.passes}/${b.runs} → ${a.passes}/${a.runs}`, d(a.wall, b.wall, s1), d(a.totalIn, b.totalIn, k1)] : null;
    }).filter(Boolean))));
    md.push('');
    compare = { base: baseDir, methods: Object.fromEntries(methods.map((m) => [m, bPer(m)])) };
  }
  return { md: md.join('\n'), json: { meta, methods: per, tasks: perTask, failures: fails.map(({ id, method, task, outcome, reason }) => ({ id, method, task, outcome, reason })), compare } };
}

export function writeReport(dir, baseDir, opts) {
  const { md, json } = summarize(dir, baseDir, opts);
  fs.writeFileSync(path.join(dir, 'summary.md'), md + '\n');
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(json, null, 2));
  return md;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), reanalyze = args.includes('--reanalyze');
  const [dir, base] = args.filter((a) => a !== '--reanalyze');
  if (!dir) { console.error('node bench/report.mjs <results dir> [<baseline dir>] [--reanalyze]'); process.exit(2); }
  console.log(writeReport(path.resolve(dir), base && path.resolve(base), { reanalyze }));
}
