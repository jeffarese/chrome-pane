// The benchmark's own parts, without a browser or an agent: that each task's check passes when the
// task is done right and fails when it is done wrong, and that a run's stream is measured right.
import assert from 'node:assert/strict';
import test from 'node:test';
import { startServer } from '../bench/lib/server.mjs';
import { answerOf, hasNumber, money, numbers } from '../bench/lib/site.mjs';
import { TASKS } from '../bench/lib/tasks.mjs';
import { analyze, imageTokens } from '../bench/lib/transcript.mjs';

test('numbers are read as written in English or in much of Europe', () => {
  assert.deepEqual(numbers('€1,234.56 and 7'), [1234.56, 7]);
  assert.deepEqual(numbers('1.234,56 €'), [1234.56]);
  assert.deepEqual(numbers('total: 12,5'), [12.5]);
  assert.ok(hasNumber('ANSWER: €98,765.43; Ada Okafor', 98765.43));
  assert.equal(answerOf('blah\nANSWER: one\nmore\nANSWER: two'), 'two');
});

test('every task is checked on what happened, not on the reply', async (t) => {
  const site = await startServer({ port: 0 });
  t.after(() => site.close());
  const go = (run, p, init) => fetch(`${site.origin}/r/${run.id}${p}`, init);
  const post = (run, p, body) => go(run, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const runOf = (task, n) => site.createRun(`${task}-${n}`, task, 1);
  const pair = (task) => [runOf(task, 'right'), runOf(task, 'wrong')];

  // Every task's first page loads, and its prompt names the page.
  for (const task of TASKS) {
    const run = runOf(task.id, 'start');
    const res = await fetch(run.url);
    assert.equal(res.status, 200, task.id);
    assert.match(await res.text(), /Larkspur Supply/, task.id);
    assert.ok(task.prompt(run.data, run.url).includes(run.url), task.id);
    assert.equal(run.firstHit !== null, true);
  }

  // The same round gives the same data; another round, other data.
  assert.deepEqual(site.createRun('a', 'read-order', 2).data, site.createRun('b', 'read-order', 2).data);
  assert.notDeepEqual(site.createRun('c', 'read-order', 2).data, site.createRun('d', 'read-order', 3).data);

  {
    const [a] = pair('read-order'), o = a.data.target;
    assert.ok(a.task.verify(a, `ANSWER: ${money(o.total)}; ${o.customer}`).pass);
    assert.ok(!a.task.verify(a, `ANSWER: ${money(o.total + 1)}; ${o.customer}`).pass);
    const html = await (await go(a, `/orders?q=${o.id}`)).text();
    assert.ok(html.includes(o.customer) && html.includes(money(o.total)));
  }
  {
    const [a, b] = pair('checkout'), w = a.data.who;
    const form = (gift) => new URLSearchParams({ name: w.name, email: w.email, street: w.street, city: w.city, postcode: w.postcode, country: 'Spain', delivery: a.data.delivery, ...(gift ? { gift: 'yes' } : {}), notes: '' }).toString();
    const send = (run, gift) => go(run, '/checkout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(gift) });
    await send(a, a.data.gift);
    assert.deepEqual(a.task.verify(a), { pass: true, reason: '' });
    assert.ok(a.doneAt);
    await send(b, !b.data.gift);
    assert.match(b.task.verify(b).reason, /gift/);
    await send(a, a.data.gift);
    assert.match(a.task.verify(a).reason, /2 times/);
  }
  {
    const [a, b] = pair('shop-cart'), d = a.data;
    const name = d.products.find((p) => p.sku === d.target).name;
    const hits = await (await go(a, `/shop/search?q=${encodeURIComponent(name.split(' ').pop())}`)).text();
    assert.ok(hits.includes(name) && hits.includes(`${name} Mini`));
    for (let i = 0; i < d.qty; i++) await post(a, '/api/cart', { sku: d.target, colour: d.colour, qty: 1 });
    assert.ok(a.task.verify(a).pass);
    const mini = d.products.find((p) => p.name === `${name} Mini`).sku;
    await post(b, '/api/cart', { sku: mini, colour: d.colour, qty: d.qty });
    assert.ok(!b.task.verify(b).pass);
  }
  {
    const [a, b] = pair('async-report'), d = a.data;
    a.data.delay = b.data.delay = 10;
    const j = await (await go(a, `/api/report?period=${encodeURIComponent(d.period)}`)).json();
    assert.ok(a.task.verify(a, `ANSWER: ${j.revenue}`).pass);
    assert.ok(!b.task.verify(b, `ANSWER: ${j.revenue}`).pass, 'a report never generated does not pass');
    const old = money(d.figures['Q4 2026'].revenue);
    assert.ok(!a.task.verify(a, `ANSWER: ${old}`).pass, "the old report's figure does not pass");
  }
  {
    const [a, b] = pair('dialog-delete');
    await go(a, `/api/addresses/${a.data.target}`, { method: 'DELETE' });
    assert.ok(a.task.verify(a).pass);
    const other = b.data.addresses.find((x) => x.id !== b.data.target).id;
    await go(b, `/api/addresses/${other}`, { method: 'DELETE' });
    assert.ok(!b.task.verify(b).pass);
    assert.ok(!(await (await go(a, '/account/addresses')).text()).includes(`id="a${a.data.target}"`));
  }
  {
    const [a, b] = pair('long-settings'), d = a.data;
    await post(a, '/api/export', { format: d.format, archived: true, attachments: d.attachments });
    assert.ok(a.task.verify(a).pass);
    await post(b, '/api/export', { format: d.format, archived: false, attachments: d.attachments });
    assert.match(b.task.verify(b).reason, /archived/);
  }
  {
    const [a] = pair('paginated');
    const refunds = a.data.tx.filter((x) => x.status === 'Refunded');
    const total = refunds.reduce((n, x) => n + x.amount, 0);
    assert.ok(a.task.verify(a, `ANSWER: ${refunds.length}; ${money(total)}`).pass);
    assert.ok(!a.task.verify(a, `ANSWER: ${refunds.length + 1}; ${money(total)}`).pass);
    const page3 = await (await go(a, '/transactions?page=3')).text();
    assert.match(page3, /Showing 25–34 of 34/);
    const filtered = await (await go(a, '/transactions?status=Refunded')).text();
    assert.equal((filtered.match(/<td>Refunded<\/td>/g) || []).length, refunds.length);
  }
  {
    const [a, b] = pair('custom-widgets'), d = a.data;
    assert.equal((await go(a, `/tickets/${d.ticket}`)).status, 200);
    await post(a, '/api/ticket', { priority: d.priority, assignee: d.assignee });
    assert.ok(a.task.verify(a).pass);
    await post(b, '/api/ticket', { priority: d.priority, assignee: null });
    assert.match(b.task.verify(b).reason, /assignee/);
  }
});

test('a run is measured from its stream: time split, tokens, tool calls', () => {
  const u = (input, read, write, out) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: out });
  const lines = [
    { t: 400, o: { type: 'system', subtype: 'init', session_id: 's', model: 'm', tools: ['Bash'], mcp_servers: [{ name: 'x', status: 'connected' }] } },
    { t: 2400, o: { type: 'assistant', message: { id: 'a1', usage: u(2, 10000, 0, 50), content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'chrome-pane open x' } }] } } },
    { t: 3400, o: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'page text'.repeat(40) }] } } },
    { t: 5400, o: { type: 'assistant', message: { id: 'a2', usage: u(2, 10000, 400, 30), content: [{ type: 'tool_use', id: 'u2', name: 'mcp__b__shot', input: {} }] } } },
    { t: 5900, o: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u2', is_error: true, content: [{ type: 'image', w: 1568, h: 784 }, { type: 'text', text: 'no' }] }] } } },
    { t: 7900, o: { type: 'assistant', message: { id: 'a3', usage: u(2, 12000, 0, 5), content: [{ type: 'thinking' }] } } },
    { t: 8000, o: { type: 'assistant', message: { id: 'a3', usage: u(2, 12000, 0, 9), content: [{ type: 'text', text: 'ANSWER: 1' }] } } },
    { t: 8100, o: { type: 'result', subtype: 'success', is_error: false, duration_ms: 7700, duration_api_ms: 5000, num_turns: 3, total_cost_usd: 0.1, result: 'ANSWER: 1', modelUsage: { m: { inputTokens: 6, outputTokens: 89, cacheReadInputTokens: 32000, cacheCreationInputTokens: 400, costUSD: 0.1 } } } },
  ];
  const m = analyze(lines);
  assert.equal(m.initMs, 400);
  assert.equal(m.turns, 3);
  assert.equal(m.modelMs, 2000 + 2000 + 2100);
  assert.equal(m.toolMs, 1000 + 500);
  assert.equal(m.toolCalls, 2);
  assert.equal(m.toolErrors, 1);
  assert.equal(m.images, 1);
  assert.equal(m.imageTokensEst, imageTokens(1568, 784));
  assert.equal(m.totalIn, 6 + 32000 + 400);
  assert.equal(m.usage.output, 89);
  assert.equal(m.ctxFirst, 10002);
  assert.equal(m.ctxMax, 12002);
  assert.equal(m.toolResultTokens, (10402 - 10002 - 50) + (12002 - 10402 - 30));
  assert.equal(m.calls[0].input, 'chrome-pane open x');
  assert.equal(m.reply, 'ANSWER: 1');
  assert.equal(m.firstToolMs, 2400);
});

test('calls asked for together are timed one after another', () => {
  const lines = [
    { t: 0, o: { type: 'system', subtype: 'init' } },
    { t: 1000, o: { type: 'assistant', message: { id: 'a', content: [{ type: 'tool_use', id: 'x', name: 'f', input: {} }, { type: 'tool_use', id: 'y', name: 'f', input: {} }] } } },
    { t: 3000, o: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'a' }] } } },
    { t: 3500, o: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'y', content: 'b' }] } } },
  ];
  const m = analyze(lines);
  assert.deepEqual(m.calls.map((c) => c.ms), [2000, 500]);
  assert.equal(m.toolMs, 2500);
  // Asked for in blocks that arrive one by one, run once the message has ended.
  const late = analyze([
    { t: 0, o: { type: 'system', subtype: 'init' } },
    { t: 1000, o: { type: 'assistant', message: { id: 'a', content: [{ type: 'tool_use', id: 'x', name: 'f', input: {} }] } } },
    { t: 4000, o: { type: 'assistant', message: { id: 'a', content: [{ type: 'tool_use', id: 'y', name: 'f', input: {} }] } } },
    { t: 4300, o: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'a' }] } } },
    { t: 4500, o: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'y', content: 'b' }] } } },
  ]);
  assert.deepEqual(late.calls.map((c) => c.ms), [300, 200]);
});
