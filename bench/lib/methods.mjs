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

const AGENT_BROWSER_ENV = { AGENT_BROWSER_NAMESPACE: 'chrome-pane-bench', AGENT_BROWSER_SESSION: 'bench' };

// Its reports of use and of crashes stay off: a benchmark is nobody's use of it.
const TERMINAL_BROWSER_ENV = { DO_NOT_TRACK: '1', TERMINAL_BROWSER_NO_TELEMETRY: '1' };

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

  'agent-browser': {
    describe: "agent-browser (Vercel), a command run through Bash, on a Chrome of its own (headless, a new profile each run)",
    tools: ['Bash', 'Read'],
    allowed: ['Bash(agent-browser:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(grep:*)', 'Bash(sed -n:*)', 'Bash(cut:*)', 'Bash(wc:*)', 'Bash(sort:*)', 'Read'],
    // A namespace of the benchmark's own: its browsers are not those of another agent on this
    // computer, and closing them all after a run closes nobody else's. The session too: its
    // guide has the agent ask for a name with $(...), which the permissions of a run refuse.
    env: () => AGENT_BROWSER_ENV,
    setup(ctx) { ctx.agentBrowserSkill = sh('agent-browser', ['skills', 'path', 'core']).out; },
    guide: (ctx) => `Work in the browser only with agent-browser, a command you run with Bash. A session of your own is already set for every command (AGENT_BROWSER_SESSION is in the environment): skip the guide's step that asks for a session name, and do not pass --session. Only agent-browser commands are allowed, alone or joined with && or piped to head, tail or grep: a loop or $(...) is refused. Its guide:\n\n${stripFrontmatter(fs.readFileSync(path.join(ctx.agentBrowserSkill, 'SKILL.md'), 'utf8'))}`,
    // Its browser outlives the commands: each run starts without one, as a new task does.
    after: () => { sh('agent-browser', ['close', '--all'], { env: { ...process.env, ...AGENT_BROWSER_ENV }, timeout: 30000 }); },
    preflight() {
      const v = sh('agent-browser', ['--version']);
      if (!v.ok) return { ok: false, detail: 'agent-browser is not installed (brew install agent-browser, or npm i -g agent-browser)' };
      const chrome = sh('agent-browser', ['doctor']).out.split('\n').find((l) => /pass\s+.*Chrom/.test(l));
      if (!chrome) return { ok: false, detail: 'agent-browser has no browser: agent-browser install' };
      return { ok: true, detail: chrome.trim().replace(/^pass\s+/, ''), version: v.out };
    },
  },

  'terminal-browser': {
    describe: 'terminal-browser (zenbu-labs), a Chromium of its own drawn in a terminal pane beside the agent, driven through Bash with its agent-browser commands; started anew each run',
    tools: ['Bash', 'Read'],
    allowed: ['Bash(terminal-browser:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(grep:*)', 'Bash(sed -n:*)', 'Bash(cut:*)', 'Bash(wc:*)', 'Bash(sort:*)', 'Read'],
    env: () => TERMINAL_BROWSER_ENV,
    setup(ctx) { ctx.terminalBrowserSkill = path.join(path.dirname(fs.realpathSync(sh('which', ['terminal-browser']).out)), '../skills/default/terminal-browser/SKILL.md'); },
    guide: (ctx) => `Work in the browser only with terminal-browser, a command you run with Bash. Only terminal-browser commands are allowed, alone or joined with && or piped to head, tail or grep: a loop or $(...) is refused. Its guide:\n\n${stripFrontmatter(fs.readFileSync(ctx.terminalBrowserSkill, 'utf8'))}`,
    // Its panes stay open after the agent is done: closed here, and with the last one its browser ends.
    after() {
      const env = { ...process.env, ...TERMINAL_BROWSER_ENV };
      let browsers = [];
      try { browsers = JSON.parse(sh('terminal-browser', ['ls', '--all', '--json'], { env }).out).browsers ?? []; } catch {}
      for (const b of browsers) {
        // The agent-browser it runs for a tab outlives the tab unless told to close.
        sh('terminal-browser', ['action', '--browser', b.key, '--', 'close'], { env });
        if (process.env.REX_BLOCK && b.pane?.pane) sh('rex', ['block', 'close', b.pane.pane]);
      }
      sh('terminal-browser', ['shutdown'], { env, timeout: 30000 });
    },
    preflight() {
      const env = { ...process.env, ...TERMINAL_BROWSER_ENV };
      const v = sh('terminal-browser', ['--version'], { env });
      if (!v.ok) return { ok: false, detail: 'terminal-browser is not installed (brew install terminal-browser)' };
      const ls = sh('terminal-browser', ['ls'], { env });
      if (!ls.ok) return { ok: false, detail: `terminal-browser cannot open a pane in this terminal (${ls.out.split('\n')[0].trim()}): run the benchmark from one it knows, such as Rex, Ghostty or kitty` };
      return { ok: true, detail: `a pane of ${process.env.TERM_PROGRAM ?? 'this terminal'}`, version: v.out };
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
