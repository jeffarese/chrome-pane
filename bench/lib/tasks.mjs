// The tasks: each one a page or a few of the test shop, the words a person would use to ask for
// it, and a check of the outcome that does not take the agent's word for it. Whatever the agent
// changes is checked on the server; what it reads is checked against the data the page showed.
//
// A task's data comes from a seed made of the task and the repetition, so every method gets the
// same orders, names and amounts in the same round, and a new round gets new ones.
import { answerOf, cents, day, esc, hasNumber, includes, int, layout, money, people, person, pick, same, shuffle, some } from './site.mjs';

const ok = (pass, reason = '') => ({ pass, reason });
const json = (body, status = 200) => ({ status, json: body });

// ---------------------------------------------------------------------------------------------
const readOrder = {
  id: 'read-order',
  category: 'read',
  title: 'Find one order in a table of 40 and report its total and customer',
  start: '/orders',
  answer: true,
  data(r) {
    const seen = new Set(), orders = [];
    const who = people(r, 30);
    while (orders.length < 40) {
      const id = `LS-${int(r, 10000, 99999)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      orders.push({ id, customer: pick(r, who).name, date: day(r), status: pick(r, ['Paid', 'Paid', 'Shipped', 'Shipped', 'Refunded', 'Pending']), total: cents(r, 12, 980) });
    }
    orders.sort((a, b) => b.date.localeCompare(a.date));
    return { orders, target: orders[int(r, 22, 39)] };
  },
  prompt: (d, url) => `Open ${url}. What is the total of order ${d.target.id}, and which customer placed it? End your reply with a line "ANSWER: <total>; <customer name>".`,
  route({ d, path, query, base }) {
    if (path !== '/orders') return null;
    const q = (query.get('q') || '').trim().toLowerCase();
    const rows = d.orders.filter((o) => !q || o.id.toLowerCase().includes(q) || o.customer.toLowerCase().includes(q));
    return { html: layout(base, 'Orders', `<h1>Orders</h1><p class="lead">${d.orders.length} orders this year.</p>
<form role="search" style="margin:0 0 14px"><label>Search orders <input name="q" type="search" value="${esc(q)}"></label> <button>Search</button></form>
<table><caption class="muted" style="text-align:left;padding:8px 12px">${rows.length} orders</caption>
<thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Status</th><th class="num">Total</th></tr></thead><tbody>
${rows.map((o) => `<tr><td>${o.id}</td><td>${esc(o.customer)}</td><td>${o.date}</td><td>${o.status}</td><td class="num">${money(o.total)}</td></tr>`).join('\n')}
</tbody></table>`, { active: 'orders' }) };
  },
  verify(run, reply) {
    const t = run.data.target, a = answerOf(reply);
    if (!hasNumber(a, t.total / 100)) return ok(false, `total ${money(t.total)} not in the answer`);
    if (!includes(a, t.customer)) return ok(false, `customer ${t.customer} not in the answer`);
    return ok(true);
  },
};

// ---------------------------------------------------------------------------------------------
const DELIVERY = [['standard', 'Standard, 3 to 5 days (free)'], ['express', 'Express, next day (€9.90)'], ['pickup', 'Pick up in store']];
const checkout = {
  id: 'checkout',
  category: 'form',
  title: 'Fill a checkout form (text, select, checkbox) and place the order',
  start: '/checkout',
  data(r) {
    return { who: person(r), delivery: pick(r, ['standard', 'express']), gift: r() < 0.6 };
  },
  init: () => ({ posts: [] }),
  prompt(d, url) {
    const w = d.who, del = DELIVERY.find(([v]) => v === d.delivery)[1].replace(/ \(.*/, '');
    return `Open ${url} and place the order with these details. Name: ${w.name}. Email: ${w.email}. Address: ${w.street}. City: ${w.city}. Postcode: ${w.postcode}. Delivery: ${del}. Gift wrap: ${d.gift ? 'yes' : 'no'}. Placing the order is authorized.`;
  },
  route({ s, method, path, form, base }) {
    if (path !== '/checkout') return null;
    if (method === 'POST') {
      const f = form();
      s.posts.push(f);
      return { html: layout(base, 'Order placed', `<h1>Thank you, ${esc(f.name || 'customer')}!</h1><p class="status" role="status">Order LS-${70000 + s.posts.length} is placed. A confirmation is on its way to ${esc(f.email || '')}.</p>`) };
    }
    return { html: layout(base, 'Checkout', `<h1>Checkout</h1><p class="lead">Two items, sent from our Valencia warehouse.</p>
<div style="display:grid;grid-template-columns:1fr 260px;gap:24px;align-items:start">
<form method="post" class="card">
<h2 style="margin-top:0">Where should we send it?</h2>
<div class="field"><label for="name">Full name</label><input id="name" name="name" autocomplete="name" required></div>
<div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div>
<div class="field"><label for="street">Street address</label><input id="street" name="street" autocomplete="street-address" required></div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
<div class="field"><label for="city">City</label><input id="city" name="city" required></div>
<div class="field"><label for="postcode">Postcode</label><input id="postcode" name="postcode" required></div></div>
<div class="field"><label for="country">Country</label><select id="country" name="country"><option>Spain</option><option>Portugal</option><option>United Kingdom</option><option>Germany</option><option>Italy</option><option>Netherlands</option><option>France</option><option>Poland</option><option>Sweden</option><option>Ireland</option></select></div>
<div class="field"><label for="delivery">Delivery</label><select id="delivery" name="delivery">${DELIVERY.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
<p><label><input type="checkbox" name="gift" value="yes"> Gift wrap (€3.50)</label></p>
<div class="field"><label for="notes">Notes for the courier (optional)</label><textarea id="notes" name="notes" rows="2"></textarea></div>
<button type="submit">Place order</button> <a href="${base}/shop/cart" class="muted">Back to the cart</a>
</form>
<aside class="card"><h2 style="margin-top:0">Your order</h2><table><tr><td>Sencha, 100 g</td><td class="num">€12.40</td></tr><tr><td>Clay teapot</td><td class="num">€38.00</td></tr><tr><td><b>Total</b></td><td class="num"><b>€50.40</b></td></tr></table></aside>
</div>`, { active: 'shop' }) };
  },
  done: (run) => run.state.posts.length > 0 && checkout.verify(run).pass,
  verify(run) {
    const { posts } = run.state, d = run.data, w = d.who;
    if (!posts.length) return ok(false, 'no order was placed');
    if (posts.length > 1) return ok(false, `the order was placed ${posts.length} times`);
    const f = posts[0];
    for (const k of ['name', 'email', 'street', 'city', 'postcode']) if (!same(f[k], w[k])) return ok(false, `${k} is ${JSON.stringify(f[k] ?? null)}, not ${JSON.stringify(w[k])}`);
    if (f.delivery !== d.delivery) return ok(false, `delivery is ${f.delivery}, not ${d.delivery}`);
    if ((f.gift === 'yes') !== d.gift) return ok(false, `gift wrap is ${f.gift === 'yes' ? 'on' : 'off'}`);
    return ok(true);
  },
};

// ---------------------------------------------------------------------------------------------
const MATERIALS = ['Copper', 'Steel', 'Glass', 'Enamel', 'Ceramic', 'Cast-iron'];
const ITEMS = ['Gooseneck Kettle', 'Stovetop Kettle', 'Electric Kettle', 'French Press', 'Teapot', 'Milk Jug', 'Coffee Grinder'];
const COLOURS = ['Matte Black', 'Brushed Steel', 'Ivory', 'Sage Green', 'Copper', 'Navy'];
const shopCart = {
  id: 'shop-cart',
  category: 'navigate',
  title: 'Search a shop, open the right product among look-alikes, pick a colour and a quantity, add to cart',
  start: '/shop',
  data(r) {
    const products = [];
    for (const m of MATERIALS) for (const it of ITEMS) {
      products.push({ sku: `P${products.length + 101}`, name: `${m} ${it}`, price: cents(r, 18, 140), colours: some(r, COLOURS, 3) });
    }
    const kettles = products.filter((p) => /Kettle/.test(p.name));
    const target = pick(r, kettles);
    products.push({ sku: `P${products.length + 101}`, name: `${target.name} Mini`, price: Math.round(target.price * 0.8), colours: target.colours });
    return { products, target: target.sku, colour: pick(r, target.colours), qty: int(r, 2, 3) };
  },
  init: () => ({ cart: [] }),
  prompt(d, url) {
    const p = d.products.find((x) => x.sku === d.target);
    return `Open ${url}. Use the shop's search to find the "${p.name}" and add ${d.qty} of them in ${d.colour} to the cart.`;
  },
  route({ d, s, method, path, query, json: body, base }) {
    const card = (p) => `<li class="card" style="list-style:none"><a href="${base}/shop/p/${p.sku}">${esc(p.name)}</a> <span class="muted">${money(p.price)}</span></li>`;
    const count = s.cart.reduce((n, l) => n + l.qty, 0);
    const shopHead = `<p style="float:right"><a href="${base}/shop/cart">Cart (${count})</a></p>`;
    if (path === '/shop') {
      const popular = d.products.filter((p) => !/Kettle/.test(p.name)).slice(0, 6);
      return { html: layout(base, 'Shop', `${shopHead}<h1>Shop</h1><p class="lead">Teaware and coffee gear, ${d.products.length} products.</p>
<form role="search" action="${base}/shop/search" class="card"><label>Search the shop <input name="q" type="search"></label> <button>Search</button></form>
<h2>Popular</h2><ul style="padding:0">${popular.map(card).join('')}</ul>`, { active: 'shop' }) };
    }
    if (path === '/shop/search') {
      const q = (query.get('q') || '').trim().toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      const hits = words.length ? d.products.filter((p) => words.every((w) => p.name.toLowerCase().includes(w))) : [];
      return { html: layout(base, `Search: ${q}`, `${shopHead}<h1>Search</h1><form role="search" action="${base}/shop/search"><label>Search the shop <input name="q" type="search" value="${esc(q)}"></label> <button>Search</button></form>
<p class="lead">${hits.length} results for “${esc(q)}”</p><ul style="padding:0">${hits.map(card).join('')}</ul>`, { active: 'shop' }) };
    }
    const m = path.match(/^\/shop\/p\/(P\d+)$/);
    if (m) {
      const p = d.products.find((x) => x.sku === m[1]);
      if (!p) return null;
      return { html: layout(base, p.name, `${shopHead}<p><a href="${base}/shop">Shop</a> › ${esc(p.name)}</p><h1>${esc(p.name)}</h1><p class="lead">${money(p.price)} · ships in two days</p>
<div class="card"><p>Made in small batches. Holds about one litre.</p>
<fieldset style="border:0;padding:0;margin:0 0 12px"><legend style="font-weight:600">Colour</legend>${p.colours.map((c) => `<label style="margin-right:14px"><input type="radio" name="colour" value="${esc(c)}"> ${esc(c)}</label>`).join('')}</fieldset>
<div class="field" style="max-width:120px"><label for="qty">Quantity</label><input id="qty" type="number" min="1" max="10" value="1"></div>
<button id="add">Add to cart</button><p class="status" role="status" id="msg"></p></div>`, {
        active: 'shop',
        script: `document.getElementById('add').onclick = async () => {
  const c = document.querySelector('input[name=colour]:checked'), msg = document.getElementById('msg');
  if (!c) { msg.style.color = '#b42318'; msg.textContent = 'Choose a colour first.'; return; }
  const qty = Number(document.getElementById('qty').value) || 1;
  const r = await fetch(BASE + '/api/cart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: ${JSON.stringify(p.sku)}, colour: c.value, qty }) });
  const j = await r.json();
  msg.style.color = ''; msg.textContent = 'Added ' + qty + ' × ' + ${JSON.stringify(p.name)} + ' (' + c.value + ') to your cart. Cart: ' + j.count + ' items.';
};` }) };
    }
    if (path === '/shop/cart') {
      const lines = s.cart.map((l, i) => { const p = d.products.find((x) => x.sku === l.sku); return `<tr><td>${esc(p?.name ?? l.sku)}</td><td>${esc(l.colour)}</td><td class="num">${l.qty}</td><td><button class="quiet" onclick="drop(${i})">Remove</button></td></tr>`; });
      return { html: layout(base, 'Cart', `<h1>Cart</h1>${lines.length ? `<table><thead><tr><th>Product</th><th>Colour</th><th class="num">Qty</th><th></th></tr></thead><tbody>${lines.join('')}</tbody></table><p><a href="${base}/checkout">Go to checkout</a></p>` : '<p class="lead">Your cart is empty.</p>'}`, {
        active: 'shop', script: `async function drop(i) { await fetch(BASE + '/api/cart/' + i, { method: 'DELETE' }); location.reload(); }` }) };
    }
    if (path === '/api/cart' && method === 'POST') {
      const b = body() || {};
      const qty = Math.max(1, Math.min(10, Number(b.qty) || 1));
      const line = s.cart.find((l) => l.sku === b.sku && l.colour === b.colour);
      if (line) line.qty += qty; else s.cart.push({ sku: String(b.sku), colour: String(b.colour), qty });
      return json({ count: s.cart.reduce((n, l) => n + l.qty, 0) });
    }
    const del = path.match(/^\/api\/cart\/(\d+)$/);
    if (del && method === 'DELETE') { s.cart.splice(Number(del[1]), 1); return json({ ok: true }); }
    return null;
  },
  done: (run) => shopCart.verify(run).pass,
  verify(run) {
    const { cart } = run.state, d = run.data;
    if (!cart.length) return ok(false, 'the cart is empty');
    const want = `${d.target} ${d.colour} ×${d.qty}`, got = cart.map((l) => `${l.sku} ${l.colour} ×${l.qty}`).join(', ');
    if (cart.length !== 1 || got !== want) return ok(false, `the cart has ${got}, not ${want}`);
    return ok(true);
  },
};

// ---------------------------------------------------------------------------------------------
const QUARTERS = ['Q1 2026', 'Q2 2026', 'Q3 2026', 'Q4 2026'];
const asyncReport = {
  id: 'async-report',
  category: 'wait',
  title: 'Pick a period, generate a report that takes seconds to come, read a figure (an older report is on the page too)',
  start: '/reports',
  answer: true,
  data(r) {
    const figures = Object.fromEntries(QUARTERS.map((q) => [q, { revenue: cents(r, 80000, 400000), orders: int(r, 900, 4200) }]));
    return { figures, period: pick(r, QUARTERS.slice(0, 3)), delay: int(r, 3500, 5500) };
  },
  init: () => ({ asked: [] }),
  prompt: (d, url) => `Open ${url}, generate the sales report for ${d.period}, and tell me its net revenue. End your reply with a line "ANSWER: <net revenue>".`,
  async route({ d, s, path, query, base }) {
    if (path === '/reports') {
      const last = d.figures['Q4 2026'];
      return { html: layout(base, 'Reports', `<h1>Reports</h1><p class="lead">Sales reports are made on demand and take a few seconds.</p>
<div class="card"><h2 style="margin-top:0">Last report: Q4 2026</h2><p class="muted">Generated yesterday at 18:02</p><p>Net revenue: ${money(last.revenue)} · Orders: ${last.orders.toLocaleString('en-US')}</p></div>
<div class="card"><h2 style="margin-top:0">New report</h2><label>Period <select id="period">${QUARTERS.map((q) => `<option${q === 'Q4 2026' ? ' selected' : ''}>${q}</option>`).join('')}</select></label>
<button id="gen">Generate report</button><div id="result" aria-live="polite" style="margin-top:14px"></div></div>`, {
        active: 'reports',
        script: `const out = document.getElementById('result'), gen = document.getElementById('gen');
gen.onclick = async () => {
  const period = document.getElementById('period').value;
  gen.disabled = true; out.innerHTML = '<p class="muted">Generating the report for ' + period + '…</p>';
  const j = await (await fetch(BASE + '/api/report?period=' + encodeURIComponent(period))).json();
  gen.disabled = false;
  out.innerHTML = '<h3>Sales report: ' + j.period + '</h3><dl><dt>Net revenue</dt><dd>' + j.revenue + '</dd><dt>Orders</dt><dd>' + j.orders + '</dd><dt>Average order</dt><dd>' + j.average + '</dd></dl>';
};` }) };
    }
    if (path === '/api/report') {
      const period = query.get('period');
      const f = d.figures[period];
      if (!f) return json({ error: 'no such period' }, 400);
      s.asked.push(period);
      await new Promise((res) => setTimeout(res, d.delay));
      return json({ period, revenue: money(f.revenue), orders: f.orders.toLocaleString('en-US'), average: money(Math.round(f.revenue / f.orders)) });
    }
    return null;
  },
  verify(run, reply) {
    const d = run.data, want = d.figures[d.period].revenue;
    if (!run.state.asked.includes(d.period)) return ok(false, `the report for ${d.period} was never generated`);
    if (!hasNumber(answerOf(reply), want / 100)) return ok(false, `net revenue ${money(want)} not in the answer`);
    return ok(true);
  },
};

// ---------------------------------------------------------------------------------------------
const LABELS = ['Home', 'Old office', 'New office', 'Parents', 'Warehouse', 'Studio'];
const dialogDelete = {
  id: 'dialog-delete',
  category: 'dialog',
  title: 'Delete one of six saved addresses, through the page’s confirm() dialog',
  start: '/account/addresses',
  data(r) {
    const addresses = shuffle(r, LABELS).map((label, i) => ({ id: i + 1, label, ...person(r) }));
    return { addresses, target: pick(r, addresses.filter((a) => ['Old office', 'Warehouse', 'Studio'].includes(a.label))).id };
  },
  init: () => ({ deleted: [] }),
  prompt(d, url) {
    const a = d.addresses.find((x) => x.id === d.target);
    return `Open ${url} and delete the saved address "${a.label}". I confirm the deletion.`;
  },
  route({ d, s, method, path, base }) {
    if (path === '/account/addresses') {
      const live = d.addresses.filter((a) => !s.deleted.includes(a.id));
      return { html: layout(base, 'Addresses', `<h1>Saved addresses</h1><p class="lead">Used at checkout. ${live.length} saved.</p><p class="status" role="status" id="msg"></p>
${live.map((a) => `<article class="card" id="a${a.id}"><h2 style="margin-top:0">${esc(a.label)}</h2><p>${esc(a.name)}<br>${esc(a.street)}<br>${esc(a.postcode)} ${esc(a.city)}</p>
<button class="quiet" onclick="edit()">Edit</button> <button class="quiet" onclick="del(${a.id}, ${esc(JSON.stringify(a.label))})">Delete</button></article>`).join('\n')}`, {
        active: 'account',
        script: `function edit() { document.getElementById('msg').textContent = 'Editing is not part of this test.'; }
async function del(id, label) {
  if (!confirm('Delete the address “' + label + '”? This cannot be undone.')) return;
  await fetch(BASE + '/api/addresses/' + id, { method: 'DELETE' });
  document.getElementById('a' + id).remove();
  document.getElementById('msg').textContent = 'Address “' + label + '” deleted.';
}` }) };
    }
    const m = path.match(/^\/api\/addresses\/(\d+)$/);
    if (m && method === 'DELETE') { const id = Number(m[1]); if (!s.deleted.includes(id)) s.deleted.push(id); return json({ ok: true }); }
    return null;
  },
  done: (run) => dialogDelete.verify(run).pass,
  verify(run) {
    const { deleted } = run.state, d = run.data;
    const label = (id) => d.addresses.find((a) => a.id === id)?.label;
    if (!deleted.length) return ok(false, 'nothing was deleted');
    if (deleted.length !== 1 || deleted[0] !== d.target) return ok(false, `deleted ${deleted.map(label).join(', ')}, not ${label(d.target)}`);
    return ok(true);
  },
};

// ---------------------------------------------------------------------------------------------
const NOTICES = ['an order ships', 'an order is delivered', 'a refund is issued', 'a payment fails', 'a product is back in stock', 'a price drops on my wishlist', 'a review gets a reply', 'a new invoice is ready', 'my subscription renews', 'a teammate joins', 'a teammate leaves', 'someone mentions me', 'a ticket is assigned to me', 'a ticket I follow changes', 'a report is ready', 'an export is ready', 'a new device signs in', 'my password changes', 'an integration fails', 'the monthly summary is ready'];
const INTEGRATIONS = ['Slack', 'Google Drive', 'Dropbox', 'Xero', 'QuickBooks', 'Shopify', 'Mailchimp', 'Zapier'];
const longSettings = {
  id: 'long-settings',
  category: 'scroll',
  title: 'Find a section at the bottom of a long settings page and set radio + checkboxes, with a look-alike checkbox higher up',
  start: '/settings',
  data(r) {
    return { format: pick(r, ['JSON', 'XLSX']), attachments: r() < 0.5 };
  },
  init: () => ({ exports: [], saved: [] }),
  prompt: (d, url) => `Open ${url} and request a data export in ${d.format} format that includes archived projects${d.attachments ? ' and attachments' : ', but not attachments'}.`,
  route({ s, method, path, json: body, base }) {
    if (path === '/settings') {
      const gap = '<div style="height:900px"></div>';
      return { html: layout(base, 'Settings', `<h1>Settings</h1><p class="lead">Your account, notifications, integrations and data.</p>
<section class="card" aria-labelledby="h-profile"><h2 id="h-profile" style="margin-top:0">Profile</h2>
<div class="field"><label for="dn">Display name</label><input id="dn" value="Robin Vale"></div>
<div class="field"><label for="tz">Time zone</label><select id="tz"><option>Europe/Madrid</option><option>Europe/London</option><option>Europe/Berlin</option></select></div>
<button class="quiet" onclick="save('profile')">Save profile</button></section>${gap}
<section class="card" aria-labelledby="h-notes"><h2 id="h-notes" style="margin-top:0">Notifications</h2>${NOTICES.map((n, i) => `<p style="margin:4px 0"><label><input type="checkbox"${i % 3 ? '' : ' checked'}> Email me when ${n}</label></p>`).join('')}
<button class="quiet" onclick="save('notifications')">Save notifications</button></section>${gap}
<section class="card" aria-labelledby="h-digest"><h2 id="h-digest" style="margin-top:0">Weekly digest</h2>
<p><label><input type="checkbox" checked> Send me a weekly digest</label></p><p><label><input type="checkbox"> Include archived projects</label></p>
<div class="field"><label for="dd">Digest day</label><select id="dd"><option>Monday</option><option>Friday</option></select></div>
<button class="quiet" onclick="save('digest')">Save digest</button></section>${gap}
<section class="card" aria-labelledby="h-int"><h2 id="h-int" style="margin-top:0">Integrations</h2>${INTEGRATIONS.map((n) => `<p style="display:flex;justify-content:space-between;margin:6px 0"><span>${n}</span><button class="quiet" onclick="save('${n}')">Connect</button></p>`).join('')}</section>${gap}
<section class="card" aria-labelledby="h-sec"><h2 id="h-sec" style="margin-top:0">Security</h2><p>Two devices are signed in: this Mac, and an iPhone last seen 3 days ago.</p><button class="quiet" onclick="save('sessions')">Sign out other devices</button></section>${gap}
<section class="card" aria-labelledby="h-export"><h2 id="h-export" style="margin-top:0">Data export</h2><p class="muted">We email you a link when the export is ready.</p>
<fieldset style="border:0;padding:0;margin:0 0 10px"><legend style="font-weight:600">Format</legend>${['CSV', 'JSON', 'XLSX'].map((f) => `<label style="margin-right:14px"><input type="radio" name="format" value="${f}"${f === 'CSV' ? ' checked' : ''}> ${f}</label>`).join('')}</fieldset>
<p><label><input type="checkbox" id="x-arch"> Include archived projects</label></p><p><label><input type="checkbox" id="x-att"> Include attachments</label></p>
<button id="export">Request export</button><p class="status" role="status" id="xmsg"></p></section>`, {
        active: 'settings',
        script: `async function save(what) { await fetch(BASE + '/api/save', { method: 'POST', body: JSON.stringify({ what }) }); }
document.getElementById('export').onclick = async () => {
  const body = { format: document.querySelector('input[name=format]:checked').value, archived: document.getElementById('x-arch').checked, attachments: document.getElementById('x-att').checked };
  await fetch(BASE + '/api/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  document.getElementById('xmsg').textContent = 'Export requested: ' + body.format + (body.archived ? ', with archived projects' : '') + (body.attachments ? ', with attachments' : '') + '. We will email you a link.';
};` }) };
    }
    if (path === '/api/export' && method === 'POST') { s.exports.push(body() || {}); return json({ ok: true }); }
    if (path === '/api/save' && method === 'POST') { s.saved.push((body() || {}).what); return json({ ok: true }); }
    return null;
  },
  done: (run) => longSettings.verify(run).pass,
  verify(run) {
    const { exports } = run.state, d = run.data;
    if (!exports.length) return ok(false, 'no export was requested');
    if (exports.length > 1) return ok(false, `${exports.length} exports were requested`);
    const x = exports[0];
    if (x.format !== d.format) return ok(false, `format ${x.format}, not ${d.format}`);
    if (x.archived !== true) return ok(false, 'archived projects not included');
    if (x.attachments !== d.attachments) return ok(false, `attachments ${x.attachments ? 'included' : 'left out'}`);
    return ok(true);
  },
};

// ---------------------------------------------------------------------------------------------
const PER_PAGE = 12;
const paginated = {
  id: 'paginated',
  category: 'extract',
  title: 'Count and sum the refunded rows of a table spread over 3 pages (a status filter exists)',
  start: '/transactions',
  answer: true,
  data(r) {
    const who = people(r, 20);
    let tx;
    do {
      tx = Array.from({ length: 34 }, () => ({ id: `TX-${int(r, 100000, 999999)}`, date: day(r), customer: pick(r, who).name, status: pick(r, ['Paid', 'Paid', 'Paid', 'Paid', 'Refunded', 'Pending']), amount: cents(r, 8, 640) }));
    } while (!(() => { const n = tx.filter((t) => t.status === 'Refunded').length; return n >= 4 && n <= 8; })());
    tx.sort((a, b) => b.date.localeCompare(a.date));
    return { tx };
  },
  prompt: (d, url) => `Open ${url}. Across all of its pages, how many transactions are Refunded, and what is the sum of their amounts? End your reply with a line "ANSWER: <count>; <sum>".`,
  route({ d, path, query, base }) {
    if (path !== '/transactions') return null;
    const status = query.get('status') || 'All';
    const rows = d.tx.filter((t) => status === 'All' || t.status === status);
    const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
    const page = Math.min(pages, Math.max(1, Number(query.get('page')) || 1));
    const shown = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE);
    const link = (p, text) => `<a href="${base}/transactions?status=${encodeURIComponent(status)}&page=${p}"${p === page ? ' aria-current="page"' : ''}>${text}</a>`;
    const nav = [page > 1 ? link(page - 1, 'Previous') : '<span class="muted">Previous</span>', ...Array.from({ length: pages }, (_, i) => link(i + 1, String(i + 1))), page < pages ? link(page + 1, 'Next') : '<span class="muted">Next</span>'].join(' ');
    return { html: layout(base, 'Transactions', `<h1>Transactions</h1>
<form style="margin:0 0 12px"><label>Status <select name="status">${['All', 'Paid', 'Refunded', 'Pending'].map((x) => `<option${x === status ? ' selected' : ''}>${x}</option>`).join('')}</select></label> <button>Filter</button></form>
<p class="lead">Showing ${rows.length ? (page - 1) * PER_PAGE + 1 : 0}–${(page - 1) * PER_PAGE + shown.length} of ${rows.length}</p>
<table><thead><tr><th>Transaction</th><th>Date</th><th>Customer</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>
${shown.map((t) => `<tr><td>${t.id}</td><td>${t.date}</td><td>${esc(t.customer)}</td><td>${t.status}</td><td class="num">${money(t.amount)}</td></tr>`).join('\n')}
</tbody></table><nav aria-label="Pagination" style="margin-top:12px;display:flex;gap:10px">${nav}</nav>`, { active: 'transactions' }) };
  },
  verify(run, reply) {
    const refunds = run.data.tx.filter((t) => t.status === 'Refunded');
    const sum = refunds.reduce((n, t) => n + t.amount, 0), a = answerOf(reply);
    if (!hasNumber(a, refunds.length, 0)) return ok(false, `count ${refunds.length} not in the answer`);
    if (!hasNumber(a, sum / 100)) return ok(false, `sum ${money(sum)} not in the answer`);
    return ok(true);
  },
};

// ---------------------------------------------------------------------------------------------
const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];
const customWidgets = {
  id: 'custom-widgets',
  category: 'custom',
  title: 'Use a div-made dropdown, an autocomplete with no ARIA and a div "button" to change a ticket',
  data(r) {
    const team = people(r, 10).map((p) => p.name);
    return { ticket: int(r, 1200, 1999), team, priority: pick(r, ['Low', 'High', 'Urgent']), assignee: pick(r, team) };
  },
  start: (d) => `/tickets/${d.ticket}`,
  init: () => ({ saves: [] }),
  prompt: (d, url) => `Open ${url}. Set the ticket's priority to ${d.priority} and assign it to ${d.assignee}, then save the ticket.`,
  route({ d, s, method, path, json: body, base }) {
    if (path === '/tickets') {
      return { html: layout(base, 'Tickets', `<h1>Tickets</h1><ul>${[0, 1, 2].map((i) => `<li><a href="${base}/tickets/${d.ticket + i}">#${d.ticket + i}</a></li>`).join('')}</ul>`, { active: 'tickets' }) };
    }
    const m = path.match(/^\/tickets\/(\d+)$/);
    if (m && Number(m[1]) === d.ticket) {
      return { html: layout(base, `Ticket #${d.ticket}`, `<p><a href="${base}/tickets">Tickets</a> › #${d.ticket}</p><h1>#${d.ticket} Kettle arrived with a dented lid</h1>
<p class="lead">Opened 2 days ago by a customer, through the contact form.</p>
<div style="display:grid;grid-template-columns:1fr 280px;gap:24px;align-items:start"><div class="card"><p>Hello, the gooseneck kettle I ordered arrived today and its lid is dented, so it does not close. Could you send a new lid, or a new kettle? The order is LS-48213. Thanks.</p></div>
<div class="card"><div class="prop-label muted">Priority</div><div class="dd" id="prio"><div class="dd-cur">Normal ▾</div><div class="dd-menu" hidden>${PRIORITIES.map((p) => `<div class="dd-opt">${p}</div>`).join('')}</div></div>
<div class="prop-label muted" style="margin-top:14px">Assignee</div><div class="combo"><input id="who" placeholder="Type a name…" autocomplete="off" value=""><div class="sugg" hidden></div></div><div class="muted" id="chosen" style="font-size:13px">Unassigned</div>
<div style="margin-top:18px"><div class="btn" id="save">Save changes</div> <div class="btn quiet" id="cancel">Cancel</div></div><div id="msg" class="status" style="margin-top:10px"></div></div></div>`, {
        active: 'tickets',
        head: `.dd { position:relative; } .dd-cur { padding:8px 10px; border:1px solid var(--line); border-radius:8px; cursor:pointer; background:#fff; }
.dd-menu { position:absolute; left:0; right:0; top:100%; background:#fff; border:1px solid var(--line); border-radius:8px; z-index:2; box-shadow:0 6px 20px #0002; }
.dd-opt, .sugg div { padding:7px 10px; cursor:pointer; } .dd-opt:hover, .sugg div:hover, .sugg div.hi { background:#eef3ff; }
.combo { position:relative; } .combo input { width:100%; } .sugg { position:absolute; left:0; right:0; top:100%; background:#fff; border:1px solid var(--line); border-radius:8px; z-index:2; box-shadow:0 6px 20px #0002; }`,
        script: `const TEAM = ${JSON.stringify(d.team)};
let priority = 'Normal', assignee = null;
const cur = document.querySelector('.dd-cur'), menu = document.querySelector('.dd-menu');
cur.onclick = () => { menu.hidden = !menu.hidden; };
for (const o of document.querySelectorAll('.dd-opt')) o.onclick = () => { priority = o.textContent; cur.textContent = priority + ' ▾'; menu.hidden = true; };
const who = document.getElementById('who'), sugg = document.querySelector('.sugg'), chosen = document.getElementById('chosen');
function pickName(n) { assignee = n; who.value = n; chosen.textContent = 'Assigned to ' + n; sugg.hidden = true; }
who.oninput = () => {
  const q = who.value.trim().toLowerCase(), hits = q ? TEAM.filter((n) => n.toLowerCase().includes(q)) : [];
  sugg.innerHTML = ''; hits.forEach((n, i) => { const d = document.createElement('div'); d.textContent = n; if (!i) d.className = 'hi'; d.onmousedown = (e) => { e.preventDefault(); pickName(n); }; sugg.append(d); });
  sugg.hidden = !hits.length;
};
who.onkeydown = (e) => { if (e.key === 'Enter') { const f = sugg.querySelector('div'); if (f && !sugg.hidden) { e.preventDefault(); pickName(f.textContent); } } };
who.onblur = () => setTimeout(() => { sugg.hidden = true; }, 150);
document.getElementById('save').onclick = async () => {
  await fetch(BASE + '/api/ticket', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ priority, assignee }) });
  document.getElementById('msg').textContent = 'Saved: ' + priority + ', ' + (assignee || 'unassigned') + '.';
};
document.getElementById('cancel').onclick = () => location.reload();` }) };
    }
    if (m) return { html: layout(base, `Ticket #${m[1]}`, `<h1>#${m[1]}</h1><p class="lead">This ticket is not part of the test.</p>`, { active: 'tickets' }) };
    if (path === '/api/ticket' && method === 'POST') { s.saves.push(body() || {}); return json({ ok: true }); }
    return null;
  },
  done: (run) => customWidgets.verify(run).pass,
  verify(run) {
    const { saves } = run.state, d = run.data;
    if (!saves.length) return ok(false, 'the ticket was never saved');
    const last = saves[saves.length - 1];
    if (last.priority !== d.priority) return ok(false, `priority saved as ${last.priority}, not ${d.priority}`);
    if (last.assignee !== d.assignee) return ok(false, `assignee saved as ${last.assignee ?? 'nobody'}, not ${d.assignee}`);
    return ok(true);
  },
};

// ---------------------------------------------------------------------------------------------
/** Not measured: opens each method's way into the browser (a pane, a tab group, a browser of its own) before the rounds. */
const warmup = {
  id: 'warmup',
  category: 'warmup',
  title: 'Open a page and read a code (run before the measured rounds)',
  start: '/hello',
  answer: true,
  data: (r) => ({ code: String(int(r, 1000, 9999)) }),
  prompt: (d, url) => `Open ${url} and tell me the warm-up code it shows. End your reply with a line "ANSWER: <code>".`,
  route: ({ d, path, base }) => (path === '/hello' ? { html: layout(base, 'Hello', `<h1>Hello</h1><p>Warm-up code: <b>${d.code}</b></p>`) } : null),
  verify: (run, reply) => ok(answerOf(reply).includes(run.data.code), 'the code is not in the answer'),
};

export const TASKS = [readOrder, checkout, shopCart, asyncReport, dialogDelete, longSettings, paginated, customWidgets];
export const ALL_TASKS = [...TASKS, warmup];
export const taskById = (id) => ALL_TASKS.find((t) => t.id === id);
export const startPath = (task, data) => (typeof task.start === 'function' ? task.start(data) : task.start);
