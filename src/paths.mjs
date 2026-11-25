import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function stateDir() {
  if (process.env.CHROME_PANE_STATE) return process.env.CHROME_PANE_STATE;
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'chrome-pane');
}
export const socketPath = () => process.env.CHROME_PANE_SOCKET || path.join(stateDir(), 'bridge.sock');
export const logPath = () => path.join(stateDir(), 'bridge.log');
export const pidPath = () => path.join(stateDir(), 'bridge.pid');

// Where each Chromium browser keeps the file that names its debugging port.
function userDataDirs() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    return ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge']
      .map((d) => path.join(base, d));
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return ['google-chrome', 'google-chrome-beta', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge'].map((d) => path.join(base, d));
}

/** The browser's DevTools WebSocket, from its DevToolsActivePort file. */
export function chromeWsUrl(opts = {}) {
  if (opts.ws || process.env.CHROME_PANE_WS) return opts.ws || process.env.CHROME_PANE_WS;
  const dirs = opts.userDataDir || process.env.CHROME_PANE_USER_DATA_DIR
    ? [opts.userDataDir || process.env.CHROME_PANE_USER_DATA_DIR]
    : userDataDirs();
  for (const dir of dirs) {
    let text;
    try { text = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8'); } catch { continue; }
    const [port, wsPath] = text.trim().split('\n');
    if (/^\d+$/.test(port) && wsPath) return `ws://127.0.0.1:${port}${wsPath}`;
  }
  throw new Error('Chrome has remote debugging off. Turn it on at chrome://inspect/#remote-debugging');
}
