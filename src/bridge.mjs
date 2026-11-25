// The bridge: one connection to Chrome, shared by every viewer on this machine.
//
// Chrome asks the person to allow each new debugging connection, so the bridge holds one and
// viewers talk to it over a unix socket: DevTools messages as JSON, one per line, in both
// directions. A line with a `bridge` key is the bridge's own news: waiting (for that
// approval), ready, or closed with a reason.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromeWsUrl, pidPath, socketPath } from './paths.mjs';

export function canConnect(sock) {
  return new Promise((resolve) => {
    const c = net.connect(sock);
    c.once('connect', () => { c.destroy(); resolve(true); });
    c.once('error', () => resolve(false));
  });
}

export async function runBridge(opts = {}) {
  const sock = opts.socket || socketPath();
  if (Buffer.byteLength(sock) > 100) throw new Error(`the socket path is too long for a unix socket: ${sock} (set CHROME_PANE_STATE to a shorter folder)`);
  fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
  if (await canConnect(sock)) { console.error('chrome-pane: the bridge is already running'); return; }
  try { fs.unlinkSync(sock); } catch {}

  const log = (...a) => console.error(new Date().toISOString(), ...a);
  const idleMs = (opts.idle ?? 0) * 1000;
  const clients = new Set();
  const pending = new Map();   // our id -> { client, id, method }
  const sessions = new Map();  // DevTools session -> the client that attached it
  const waiting = [];          // requests that came before Chrome let us in
  let nextId = 0, state = 'waiting', reason = null, product = null, ws = null, idleTimer = null, stopping = false;

  const tell = (c, o) => { if (!c.destroyed) c.write(JSON.stringify(o) + '\n'); };
  const news = () => (state === 'ready' ? { bridge: 'ready', product } : state === 'closed' ? { bridge: 'closed', reason } : { bridge: 'waiting' });

  function toChrome(client, msg) {
    const id = ++nextId;
    pending.set(id, { client, id: msg.id, method: msg.method, detaches: msg.method === 'Target.detachFromTarget' ? msg.params?.sessionId : null });
    const o = { id, method: msg.method, params: msg.params ?? {} };
    if (msg.sessionId) o.sessionId = msg.sessionId;
    ws.send(JSON.stringify(o));
  }

  function stop(why, code = 0) {
    if (stopping) return;
    stopping = true;
    log('stopping:', why);
    state = 'closed'; reason = why;
    for (const c of clients) { tell(c, news()); c.end(); }
    server.close();
    try { fs.unlinkSync(sock); } catch {}
    try { fs.unlinkSync(pidPath()); } catch {}
    try { ws?.close(); } catch {}
    setTimeout(() => process.exit(code), 150);
  }

  function armIdle() {
    clearTimeout(idleTimer);
    if (idleMs > 0 && clients.size === 0) idleTimer = setTimeout(() => stop('no viewer for a while'), idleMs);
  }

  const server = net.createServer((c) => {
    clients.add(c);
    clearTimeout(idleTimer);
    c.setEncoding('utf8');
    c.sessions = new Set();
    tell(c, news());
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (typeof msg.method !== 'string') continue;
        if (state === 'ready') toChrome(c, msg);
        else if (state === 'waiting') waiting.push([c, msg]);
      }
    });
    const gone = () => {
      if (!clients.delete(c)) return;
      // What this viewer attached goes back to how Chrome had it.
      for (const s of c.sessions) { sessions.delete(s); if (state === 'ready') toChrome(null, { method: 'Target.detachFromTarget', params: { sessionId: s } }); }
      armIdle();
    };
    c.on('close', gone);
    c.on('error', gone);
  });
  server.on('error', (e) => { log('socket:', e.message); process.exit(1); });
  await new Promise((r) => server.listen(sock, r));
  fs.chmodSync(sock, 0o600);
  fs.writeFileSync(pidPath(), String(process.pid));
  process.on('SIGTERM', () => stop('stopped'));
  process.on('SIGINT', () => stop('stopped'));

  let url;
  try { url = chromeWsUrl(opts); } catch (e) { state = 'closed'; reason = e.message; log(reason); setTimeout(() => stop(reason, 1), 3000); return; }
  log('connecting to', url.replace(/\/devtools\/.*/, '/…'));
  ws = new WebSocket(url);
  ws.addEventListener('open', () => {
    state = 'ready';
    log('connected');
    toChrome(null, { method: 'Browser.getVersion' });
    for (const c of clients) tell(c, news());
    for (const [c, msg] of waiting.splice(0)) if (clients.has(c)) toChrome(c, msg);
    armIdle();
  });
  ws.addEventListener('message', (ev) => {
    const text = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (!p) return;
      if (!p.client) { if (p.method === 'Browser.getVersion' && m.result) product = m.result.product; return; }
      if (p.method === 'Target.attachToTarget' && m.result?.sessionId && clients.has(p.client)) {
        sessions.set(m.result.sessionId, p.client);
        p.client.sessions.add(m.result.sessionId);
      }
      if (p.detaches && !m.error) { sessions.delete(p.detaches); p.client.sessions.delete(p.detaches); }
      m.id = p.id;
      tell(p.client, m);
      return;
    }
    if (m.sessionId) { const c = sessions.get(m.sessionId); if (c && !c.destroyed) c.write(text + '\n'); return; }
    if (m.method === 'Target.detachedFromTarget') {
      const c = sessions.get(m.params.sessionId);
      sessions.delete(m.params.sessionId);
      if (c) { c.sessions.delete(m.params.sessionId); if (!c.destroyed) c.write(text + '\n'); }
      return;
    }
    for (const c of clients) c.write(text + '\n');
  });
  ws.addEventListener('close', () => stop(state === 'ready' ? 'Chrome closed the connection' : 'Chrome did not allow the connection. Is it running, with remote debugging on (chrome://inspect/#remote-debugging), and did you accept its prompt?', state === 'ready' ? 0 : 1));
  ws.addEventListener('error', () => {});
}
