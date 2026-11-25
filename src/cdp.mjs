// A viewer's side of the bridge: DevTools calls as promises, events as callbacks.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logPath, socketPath } from './paths.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(sock) {
  return new Promise((resolve) => {
    const c = net.connect(sock);
    c.once('connect', () => resolve(c));
    c.once('error', () => resolve(null));
  });
}

function startBridge(opts) {
  fs.mkdirSync(path.dirname(logPath()), { recursive: true, mode: 0o700 });
  const log = fs.openSync(logPath(), 'a');
  const main = fileURLToPath(new URL('./chrome-pane.mjs', import.meta.url));
  const args = [main, 'bridge'];
  if (opts.userDataDir) args.push('--user-data-dir', opts.userDataDir);
  if (opts.socket) args.push('--socket', opts.socket);
  spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], env: process.env }).unref();
  fs.closeSync(log);
}

export async function connect(opts = {}) {
  const sock = opts.socket || socketPath();
  let c = await open(sock);
  if (!c && opts.autostart !== false) {
    startBridge(opts);
    for (let i = 0; i < 50 && !c; i++) { await sleep(100); c = await open(sock); }
  }
  if (!c) throw new Error(`the bridge did not start; see ${logPath()}`);
  return new Cdp(c);
}

/** Events: `event` (method, params, sessionId), `bridge` (state, detail), `close`. */
export class Cdp extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.state = 'connecting';   // until the bridge says: waiting (for Chrome's approval), ready or closed
    this.reason = null;
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line) this.handle(line);
      }
    });
    const end = () => {
      if (this.closed) return;
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(this.reason || 'the bridge went away'));
      this.pending.clear();
      this.emit('close', this.reason);
    };
    socket.on('close', end);
    socket.on('error', end);
  }

  handle(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.bridge) {
      this.state = m.bridge;
      if (m.bridge === 'closed') this.reason = m.reason;
      this.product = m.product ?? this.product;
      this.emit('bridge', m.bridge, m);
    } else if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    } else if (m.method) this.emit('event', m.method, m.params ?? {}, m.sessionId);
  }

  /** Resolves once Chrome has let the bridge in. */
  ready() {
    if (this.state === 'ready') return Promise.resolve();
    if (this.state === 'closed' || this.closed) return Promise.reject(new Error(this.reason || 'the bridge went away'));
    return new Promise((resolve, reject) => {
      const done = () => { this.off('bridge', on); this.off('close', off); };
      const on = (s) => { if (s === 'ready') { done(); resolve(); } };
      const off = (why) => { done(); reject(new Error(why || 'the bridge went away')); };
      this.on('bridge', on); this.on('close', off);
    });
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error(this.reason || 'the bridge went away'));
    const id = ++this.nextId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify(msg) + '\n');
    });
  }

  close() { this.socket.end(); }
}
