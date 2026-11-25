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
  return [
    ...['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge'].map((d) => path.join(base, d)),
    // The same browsers as a snap or a flatpak keep their folder elsewhere.
    path.join(home, 'snap/chromium/common/chromium'),
    path.join(home, '.var/app/com.google.Chrome/config/google-chrome'),
    path.join(home, '.var/app/org.chromium.Chromium/config/chromium'),
  ];
}

/** The browser's DevTools WebSocket, from its DevToolsActivePort file. */
export function chromeWsUrl(opts = {}) {
  if (opts.ws || process.env.CHROME_PANE_WS) return opts.ws || process.env.CHROME_PANE_WS;
  const dirs = opts.userDataDir || process.env.CHROME_PANE_USER_DATA_DIR
    ? [opts.userDataDir || process.env.CHROME_PANE_USER_DATA_DIR]
    : userDataDirs();
  // The newest file: a browser that crashed leaves its own behind, and the one running now
  // wrote later.
  let best = null;
  for (const dir of dirs) {
    let text, at;
    const file = path.join(dir, 'DevToolsActivePort');
    try { text = fs.readFileSync(file, 'utf8'); at = fs.statSync(file).mtimeMs; } catch { continue; }
    const [port, wsPath] = text.trim().split('\n');
    if (/^\d+$/.test(port) && wsPath && (!best || at > best.at)) best = { at, url: `ws://127.0.0.1:${port}${wsPath}` };
  }
  if (best) return best.url;
  throw new Error('Chrome has remote debugging off. Turn it on at chrome://inspect/#remote-debugging');
}
