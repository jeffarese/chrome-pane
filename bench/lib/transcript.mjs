// What a run's stream of messages (claude -p --output-format stream-json) says about it: where the
// time went (model, tools, start-up), what entered the context and what it cost, and every tool
// call with its time, its size and whether it failed. Each line carries `t`, the milliseconds since
// the run started, taken by the harness as the line arrived.

/** Width and height of a PNG, JPEG, GIF or WebP, from its first bytes. */
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (buf.length > 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const kind = buf.toString('latin1', 12, 16);
    if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
    return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

/**
 * Roughly what a picture costs a model, in tokens: about one per 750 pixels once it is scaled to
 * fit 1568 pixels on its long side and about 1.15 megapixels. An estimate: the context's growth
 * between two calls (`stepTokens`) is the real figure.
 */
export function imageTokens(w, h) {
  if (!w || !h) return 0;
  let s = Math.min(1, 1568 / Math.max(w, h));
  s = Math.min(s, Math.sqrt(1_150_000 / (w * h)));
  return Math.ceil((w * s) * (h * s) / 750);
}

/** A message with its pictures replaced by their size, to keep transcripts small. */
export function stripImages(o) {
  const content = o?.message?.content;
  if (!Array.isArray(content)) return o;
  const fix = (block) => {
    if (block?.type === 'image' && block.source?.type === 'base64' && typeof block.source.data === 'string') {
      const buf = Buffer.from(block.source.data, 'base64');
      const size = imageSize(buf) || {};
      return { type: 'image', bytes: buf.length, w: size.w, h: size.h, media_type: block.source.media_type };
    }
    if (block?.type === 'tool_result' && Array.isArray(block.content)) return { ...block, content: block.content.map(fix) };
    return block;
  };
  return { ...o, message: { ...o.message, content: content.map(fix) } };
}

const ctxOf = (u) => (u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0);

function resultSize(block) {
  let chars = 0, images = 0, imgTokens = 0;
  const parts = typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : (block.content || []);
  for (const p of parts) {
    if (p.type === 'text') chars += (p.text || '').length;
    else if (p.type === 'image') { images++; imgTokens += imageTokens(p.w, p.h); }
    else if (p.type === 'tool_reference') chars += (p.tool_name || '').length;
  }
  return { chars, images, imgTokens };
}

/** A short form of a tool call's input, for the report. */
function brief(name, input) {
  if (!input) return '';
  if (name === 'Bash') return String(input.command || '').slice(0, 160);
  if (name === 'Read') return String(input.file_path || '');
  if (name === 'ToolSearch') return String(input.query || '');
  const s = JSON.stringify(input);
  return s.length > 160 ? s.slice(0, 157) + '...' : s;
}

/** Everything measured about one run, from its lines `[{ t, o }]`. */
export function analyze(lines) {
  const init = lines.find((l) => l.o.type === 'system' && l.o.subtype === 'init');
  const resultLine = [...lines].reverse().find((l) => l.o.type === 'result');
  const result = resultLine?.o;

  const msgs = [], byId = new Map(), toolResults = new Map();
  for (const { t, o } of lines) {
    if (o.type === 'assistant' && o.message) {
      const id = o.message.id || `anon-${msgs.length}`;
      let m = byId.get(id);
      if (!m) { m = { id, first: t, last: t, usage: o.message.usage, blocks: [] }; byId.set(id, m); msgs.push(m); }
      m.last = t;
      if (o.message.usage) m.usage = o.message.usage;
      for (const b of o.message.content || []) m.blocks.push({ ...b, t });
    } else if (o.type === 'user' && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) if (b.type === 'tool_result') toolResults.set(b.tool_use_id, { t, isError: Boolean(b.is_error), ...resultSize(b), text: typeof b.content === 'string' ? b.content : (b.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n') });
    }
  }

  const calls = [];
  let prevEnd = init ? init.t : 0, modelMs = 0, toolMs = 0;
  const steps = [];
  msgs.forEach((m, i) => {
    modelMs += Math.max(0, m.last - prevEnd);
    const uses = m.blocks.filter((b) => b.type === 'tool_use');
    const ctx = ctxOf(m.usage), next = msgs[i + 1] ? ctxOf(msgs[i + 1].usage) : null;
    const out = m.usage?.output_tokens || 0;
    if (uses.length) {
      let end = m.last;
      // Calls asked for together run one after another: each one's time starts when the one before
      // it answered. Some tools start as soon as their block arrives, while the model still writes
      // the rest of its message (a result came before the message ended); others wait for the end.
      const order = uses.map((u) => ({ u, r: toolResults.get(u.id) })).sort((a, b) => (a.r?.t ?? Infinity) - (b.r?.t ?? Infinity));
      const early = order.some(({ r }) => r && r.t < m.last);
      let prev = early ? -Infinity : m.last;
      for (const { u, r } of order) {
        if (r) end = Math.max(end, r.t);
        const ms = r ? r.t - Math.max(u.t, prev) : null;
        if (r) prev = r.t;
        calls.push({
          name: u.name, input: brief(u.name, u.input), at: u.t, ms, parallel: uses.length > 1 || undefined,
          error: r?.isError ?? null, chars: r?.chars ?? 0, images: r?.images ?? 0, imgTokens: r?.imgTokens ?? 0,
          errorText: r?.isError ? String(r.text || '').slice(0, 300) : undefined, step: i,
        });
      }
      toolMs += Math.max(0, end - m.last);
      prevEnd = end;
    } else prevEnd = m.last;
    // What the step's tool results added to the context: the next call's context, less this one's,
    // less what the model wrote in this one.
    steps.push({ ctx, out, tools: uses.map((u) => u.name), added: next !== null && uses.length ? Math.max(0, next - ctx - out) : null });
  });

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const models = {};
  for (const [model, u] of Object.entries(result?.modelUsage || {})) {
    usage.input += u.inputTokens || 0; usage.output += u.outputTokens || 0;
    usage.cacheRead += u.cacheReadInputTokens || 0; usage.cacheWrite += u.cacheCreationInputTokens || 0;
    models[model] = { in: (u.inputTokens || 0) + (u.cacheReadInputTokens || 0) + (u.cacheCreationInputTokens || 0), out: u.outputTokens || 0, cost: u.costUSD };
  }
  if (!result?.modelUsage && result?.usage) {
    const u = result.usage;
    usage.input = u.input_tokens || 0; usage.output = u.output_tokens || 0;
    usage.cacheRead = u.cache_read_input_tokens || 0; usage.cacheWrite = u.cache_creation_input_tokens || 0;
  }

  const byName = {};
  for (const c of calls) {
    const s = (byName[c.name] ||= { n: 0, ms: 0, errors: 0, chars: 0, images: 0 });
    s.n++; s.ms += c.ms || 0; s.errors += c.error ? 1 : 0; s.chars += c.chars; s.images += c.images;
  }
  const browserCalls = calls.filter((c) => !['ToolSearch'].includes(c.name));
  const ctxs = steps.map((s) => s.ctx).filter(Boolean);
  const added = steps.map((s) => s.added).filter((x) => x !== null);
  const toolChars = calls.reduce((n, c) => n + c.chars, 0);
  const images = calls.reduce((n, c) => n + c.images, 0);

  return {
    sessionId: init?.o.session_id ?? null,
    model: init?.o.model ?? null,
    claudeVersion: init?.o.claude_code_version ?? null,
    mcp: (init?.o.mcp_servers || []).map((s) => `${s.name}:${s.status}`),
    toolsOffered: init?.o.tools?.length ?? 0,
    initMs: init?.t ?? null,
    firstToolMs: browserCalls[0]?.at ?? null,
    resultMs: resultLine?.t ?? null,
    modelMs, toolMs,
    apiMs: result?.duration_api_ms ?? null,
    durationMs: result?.duration_ms ?? null,
    subtype: result?.subtype ?? null,
    isError: result?.is_error ?? null,
    turns: msgs.length,
    numTurns: result?.num_turns ?? null,
    costUsd: result?.total_cost_usd ?? null,
    usage, models,
    totalIn: usage.input + usage.cacheRead + usage.cacheWrite,
    ctxFirst: ctxs[0] ?? null,
    ctxLast: ctxs[ctxs.length - 1] ?? null,
    ctxMax: ctxs.length ? Math.max(...ctxs) : null,
    toolResultTokens: added.reduce((n, x) => n + x, 0),
    toolCalls: calls.length,
    browserCalls: browserCalls.length,
    toolErrors: calls.filter((c) => c.error).length,
    toolChars, images,
    imageTokensEst: calls.reduce((n, c) => n + c.imgTokens, 0),
    denials: (result?.permission_denials || []).map((d) => `${d.tool_name}: ${brief(d.tool_name, d.tool_input)}`),
    byName, calls, steps,
    reply: typeof result?.result === 'string' ? result.result : '',
  };
}
