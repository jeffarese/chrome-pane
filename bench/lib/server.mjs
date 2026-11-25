// The test shop's web server. Every run has pages of its own under /r/<run id>/, with data made
// from the run's seed, and a record of what reached the server and when: page loads, and every
// change (an order, a cart line, a deletion) that the task's check reads afterwards.
import http from 'node:http';
import { layout, rng } from './site.mjs';
import { startPath, taskById } from './tasks.mjs';

const MAX_BODY = 64 * 1024;

/** `latency`: every answer comes that many ms late, give or take 30%, as from a server that is not on this computer. */
export function startServer({ port = 47811, host = '127.0.0.1', latency = 0 } = {}) {
  const runs = new Map();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}`);
    const send = (status, type, body, headers = {}) => {
      const answer = () => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers }); res.end(body); };
      if (latency > 0) setTimeout(answer, latency * (0.7 + 0.6 * Math.random())); else answer();
    };
    if (url.pathname === '/favicon.ico') return send(204, 'image/x-icon', '');
    const m = url.pathname.match(/^\/r\/([\w-]+)(\/.*)?$/);
    const run = m && runs.get(m[1]);
    if (!run) return send(404, 'text/html; charset=utf-8', '<!doctype html><title>Not here</title><h1>No such run</h1>');
    const path = (m[2] || '/').replace(/\/+$/, '') || '/';
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > MAX_BODY) return send(413, 'text/plain', 'too big'); }
    const at = Date.now();
    run.events.push({ t: at, method: req.method, path: path + url.search });
    if (!run.firstHit) run.firstHit = at;

    const task = run.task;
    const ctx = {
      run, d: run.data, s: run.state, method: req.method, path, query: url.searchParams, base: `/r/${run.id}`,
      form: () => Object.fromEntries(new URLSearchParams(body)),
      json: () => { try { return JSON.parse(body); } catch { return null; } },
    };
    let out;
    try { out = await task.route(ctx); }
    catch (e) { out = { status: 500, html: `<!doctype html><title>Error</title><pre>${String(e.stack)}</pre>` }; }
    if (!out && req.method === 'GET') out = commonPage(ctx);
    if (req.method !== 'GET' && !run.doneAt && task.done?.(run)) run.doneAt = Date.now();
    if (!out) return send(404, 'text/html; charset=utf-8', layout(ctx.base, 'Not found', '<h1>Not found</h1><p class="lead">There is no such page in this test.</p>'));
    if (out.json !== undefined) return send(out.status ?? 200, 'application/json', JSON.stringify(out.json));
    return send(out.status ?? 200, 'text/html; charset=utf-8', out.html);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const origin = `http://${host}:${server.address().port}`;
      resolve({
        origin, runs,
        /** A run of a task, with the data of that task's round `rep`. */
        createRun(id, taskId, rep) {
          const task = taskById(taskId);
          if (!task) throw new Error(`no task ${taskId}`);
          const data = task.data(rng(`${taskId}#${rep}`));
          const run = { id, task, rep, data, state: task.init?.() ?? {}, events: [], firstHit: null, doneAt: null };
          run.url = `${origin}/r/${id}${startPath(task, data)}`;
          runs.set(id, run);
          return run;
        },
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

/** The pages every run has: a front page, and the sections of the menu its task does not use. */
function commonPage({ path, base }) {
  if (path === '/') return { html: layout(base, 'Home', '<h1>Larkspur Supply</h1><p class="lead">Pick a section in the menu.</p>') };
  const section = path.split('/')[1];
  if (['shop', 'orders', 'transactions', 'reports', 'tickets', 'account', 'settings', 'checkout'].includes(section)) {
    return { html: layout(base, section[0].toUpperCase() + section.slice(1), `<h1>${section[0].toUpperCase() + section.slice(1)}</h1><p class="lead">This part of the shop is empty in this test.</p>`, { active: section }) };
  }
  return null;
}
