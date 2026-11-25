// What every page of the test shop shares: a seeded random source, made-up people and places,
// money, and the page around a task's own content.

/** A random source from a string: the same seed gives every method the same data. */
export function rng(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
export const pick = (r, list) => list[Math.floor(r() * list.length)];
export function shuffle(r, list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
/** Some distinct items of a list. */
export const some = (r, list, n) => shuffle(r, list).slice(0, n);

const FIRST = ['Ada', 'Bruno', 'Carmen', 'Dmitri', 'Elena', 'Farah', 'Gustavo', 'Hana', 'Ivan', 'Julia', 'Kofi', 'Lucia', 'Marco', 'Nadia', 'Oscar', 'Priya', 'Quentin', 'Rosa', 'Samir', 'Teresa', 'Umar', 'Vera', 'Wen', 'Ximena', 'Yusuf', 'Zoe'];
const LAST = ['Abara', 'Blanco', 'Castell', 'Duarte', 'Eriksen', 'Ferreira', 'Galindo', 'Hartmann', 'Ibarra', 'Jansen', 'Kovac', 'Lindqvist', 'Moreau', 'Navarro', 'Okafor', 'Petrov', 'Quiroga', 'Romano', 'Sato', 'Torres', 'Urquhart', 'Valdez', 'Weber', 'Yilmaz', 'Zamora'];
const STREETS = ['Calle del Olmo', 'Rua das Flores', 'Harbour Road', 'Linden Allee', 'Via Roma', 'Mill Lane', 'Avenida Sol', 'Kastanjelaan', 'Quai Voltaire', 'Birch Street'];
const CITIES = [['Valencia', '46001'], ['Porto', '4000-123'], ['Bristol', 'BS1 4DJ'], ['Leipzig', '04109'], ['Bologna', '40121'], ['Utrecht', '3511 AB'], ['Lyon', '69002'], ['Gdansk', '80-831'], ['Malmo', '211 22'], ['Cork', 'T12 X70A']];

export function person(r) {
  const first = pick(r, FIRST), last = pick(r, LAST);
  const [city, postcode] = pick(r, CITIES);
  return {
    name: `${first} ${last}`, first, last,
    email: `${first}.${last}${int(r, 2, 98)}@example.org`.toLowerCase(),
    street: `${pick(r, STREETS)} ${int(r, 2, 180)}`, city, postcode,
  };
}
/** Some people with distinct names. */
export function people(r, n) {
  const out = [], seen = new Set();
  while (out.length < n) { const p = person(r); if (!seen.has(p.name)) { seen.add(p.name); out.push(p); } }
  return out;
}
export const cents = (r, lo, hi) => int(r, lo * 100, hi * 100);
export const money = (c) => '€' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const day = (r) => `2026-${String(int(r, 1, 10)).padStart(2, '0')}-${String(int(r, 1, 28)).padStart(2, '0')}`;

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CSS = `
:root { --ink:#1c2330; --soft:#5b6676; --line:#e3e7ee; --accent:#2f6fed; --bg:#f6f8fb; --ok:#18794e; }
* { box-sizing:border-box; }
body { margin:0; font:15px/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif; color:var(--ink); background:var(--bg); }
header.top { display:flex; align-items:center; gap:22px; padding:12px 24px; background:#fff; border-bottom:1px solid var(--line); flex-wrap:wrap; }
header.top .brand { font-weight:700; font-size:17px; color:var(--ink); text-decoration:none; }
header.top nav { display:flex; gap:16px; flex-wrap:wrap; }
header.top nav a { color:var(--soft); text-decoration:none; }
header.top nav a.on { color:var(--ink); font-weight:600; }
header.top .who { margin-left:auto; color:var(--soft); font-size:13px; }
main { max-width:980px; margin:24px auto; padding:0 24px; }
h1 { font-size:24px; margin:0 0 6px; } h2 { font-size:17px; margin:24px 0 10px; }
.lead { color:var(--soft); margin:0 0 16px; }
table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); border-radius:10px; font-size:14px; }
th, td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--line); }
td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
label { display:inline-flex; gap:6px; align-items:center; }
.field { display:grid; gap:4px; margin:0 0 12px; font-size:13px; color:var(--soft); }
input, select, textarea { font:inherit; color:var(--ink); padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:#fff; }
button, .btn { font:inherit; font-weight:600; padding:9px 16px; border:0; border-radius:8px; color:#fff; background:var(--accent); cursor:pointer; display:inline-block; user-select:none; }
button.quiet, .btn.quiet { color:var(--ink); background:#fff; border:1px solid var(--line); }
.card { background:#fff; border:1px solid var(--line); border-radius:12px; padding:16px 18px; margin:0 0 14px; }
.status { min-height:22px; color:var(--ok); font-weight:600; }
.muted { color:var(--soft); }
footer { max-width:980px; margin:40px auto; padding:0 24px; color:var(--soft); font-size:12px; }
`;

const NAV = [['shop', 'Shop'], ['orders', 'Orders'], ['transactions', 'Transactions'], ['reports', 'Reports'], ['tickets', 'Tickets'], ['account/addresses', 'Account'], ['settings', 'Settings']];

/** A whole page of the shop around a task's content. `base` is the run's root, /r/<run>. */
export function layout(base, title, body, { active = '', head = '', script = '' } = {}) {
  const nav = NAV.map(([p, label]) => `<a href="${base}/${p}"${active === p.split('/')[0] ? ' class="on" aria-current="page"' : ''}>${label}</a>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Larkspur Supply</title><style>${CSS}${head}</style>
<header class="top"><a class="brand" href="${base}/">Larkspur Supply</a><nav aria-label="Main">${nav}</nav><span class="who">Signed in as Robin Vale</span></header>
<main>${body}</main>
<footer>Larkspur Supply is a made-up shop for testing browser tools. Nothing here is real.</footer>
${script ? `<script>const BASE = ${JSON.stringify(base)};\n${script}</script>` : ''}</html>`;
}

/** Numbers in a text, as written in English or in much of Europe (1,234.56 or 1.234,56). */
export function numbers(text) {
  const out = [];
  for (const m of String(text).matchAll(/-?\d[\d.,]*/g)) {
    let s = m[0].replace(/[.,]$/, '');
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) || /^\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
    const n = Number(s);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}
export const hasNumber = (text, want, tol = 0.005) => numbers(text).some((n) => Math.abs(n - want) <= tol);
/** The text after the last "ANSWER:" of a reply, or the whole reply. */
export function answerOf(text) {
  const m = [...String(text ?? '').matchAll(/ANSWER:\s*(.+)/gi)];
  return m.length ? m[m.length - 1][1].trim() : String(text ?? '');
}
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
export const same = (a, b) => norm(a) === norm(b);
export const includes = (hay, needle) => norm(hay).includes(norm(needle));
