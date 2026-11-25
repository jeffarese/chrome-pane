// The ways an agent can work a browser, set up as alike as possible: the same model and prompt,
// no skills, no CLAUDE.md and no other MCP servers, only the tools of the method, and each one's
// own guide (the text its makers give agents) added to the system prompt.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stripFrontmatter = (s) => s.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000, ...opts });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
};

/** What every method is told, before its own guide. */
export const COMMON = (origin) => `You are doing a browser task for a benchmark. The site at ${origin} is a local test site: nothing on it is real, and the person who asked has authorized every action the task names (placing an order, deleting, saving). Nobody can answer questions during the task, so do not ask any: do the task, then reply in a sentence or two. When the task asks for an answer, end your reply with a line "ANSWER: <answer>".`;

export const METHODS = {
  'chrome-pane': {
    describe: "chrome-pane's agent commands through Bash, on your Chrome, with the pane open beside the agent (Herdr, Rex or Tern)",
    tools: ['Bash', 'Read'],
    // Its output can be cut down in the shell, as an agent does when it is let: the filters that
    // only read are allowed too, so that a pipe to one is not a refused call.
    allowed: ['Bash(chrome-pane:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(grep:*)', 'Bash(sed -n:*)', 'Bash(cut:*)', 'Bash(wc:*)', 'Bash(sort:*)', 'Read'],
    env: (ctx) => ({ PATH: `${path.join(ctx.root, 'bin')}:${process.env.PATH}` }),
    guide: (ctx) => `Work in the browser only with chrome-pane, a command you run with Bash. Its guide:\n\n${stripFrontmatter(fs.readFileSync(path.join(ctx.root, 'skills/chrome-pane/SKILL.md'), 'utf8'))}`,
    preflight(ctx) {
      const inHost = Boolean(process.env.HC_TERMINAL_ID || process.env.REX_BLOCK || process.env.TERN_PANE);
      if (!inHost) return { ok: false, detail: 'run the benchmark from a terminal of Herdr, Rex or Tern: an agent needs one to open its pane' };
      const st = sh(path.join(ctx.root, 'bin/chrome-pane'), ['status']);
      const rev = sh('git', ['-C', ctx.root, 'describe', '--always', '--dirty']);
      return { ok: true, detail: st.out.split('\n')[0], version: `chrome-pane ${rev.out}` };
    },
  },

  'claude-in-chrome': {
    describe: 'Claude in Chrome, the extension, on your Chrome (claude --chrome)',
    tools: ['ToolSearch'],
    allowed: ['mcp__claude-in-chrome__*'],
    flags: ['--chrome'],
    mcp: 'claude-in-chrome',
    guide: () => 'Work in the browser only with Claude in Chrome: the mcp__claude-in-chrome__* tools.',
    preflight: () => ({ ok: true, detail: 'checked by the warm-up run (its MCP server must say connected)', version: 'Claude in Chrome (extension)' }),
  },

  cua: {
    describe: "cua-driver's MCP server, its typed browser tools, on a Chrome of its own (an isolated profile it launches)",
    tools: ['ToolSearch', 'Read'],
    allowed: ['mcp__cua-driver__*', 'Read'],
    mcp: 'cua-driver',
    flags: (ctx) => ['--mcp-config', ctx.cuaConfig],
    setup(ctx) {
      const bin = sh('which', ['cua-driver']).out;
      ctx.cuaConfig = path.join(ctx.out, 'cua-mcp.json');
      fs.writeFileSync(ctx.cuaConfig, JSON.stringify({ mcpServers: { 'cua-driver': { command: bin, args: ['mcp'] } } }, null, 2));
      const p = sh('cua-driver', ['skills', 'path']).out;
      ctx.cuaSkills = fs.existsSync(path.join(p, 'SKILL.md')) ? p : path.join(os.homedir(), '.claude/skills/cua-driver');
    },
    guide: (ctx) => `Work in the browser only with cua-driver: the mcp__cua-driver__* tools. Use a browser of the driver's own: browser_prepare with allow_launch true and an isolated_new profile, then its typed browser tools. Do not use the person's own Chrome windows. Its guide follows; the files it names are in ${ctx.cuaSkills} (read them with Read), and its get_guide tool serves the same guidance.\n\n${stripFrontmatter(fs.readFileSync(path.join(ctx.cuaSkills, 'SKILL.md'), 'utf8'))}`,
    preflight() {
      const v = sh('cua-driver', ['--version']);
      if (!v.ok) return { ok: false, detail: 'cua-driver is not installed' };
      const st = sh('cua-driver', ['status']);
      return { ok: true, detail: st.out.split('\n')[0], version: v.out };
    },
  },
};

export function claudeVersion() {
  try { return execFileSync('claude', ['--version'], { encoding: 'utf8', env: { ...process.env } }).trim(); } catch { return null; }
}
