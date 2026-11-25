// The harness's own hold on your Chrome, through chrome-pane's bridge: the version, and closing
// the tabs a run left behind on the test site (never a pane's tab, never any other site's).
import { connect } from '../../src/cdp.mjs';
import { listPanes } from '../../src/panes.mjs';

async function withChrome(fn) {
  let cdp;
  try {
    cdp = await connect({ autostart: false });
    await Promise.race([cdp.ready(), new Promise((_, no) => setTimeout(() => no(new Error('Chrome has not let the bridge in')), 5000))]);
    return await fn(cdp);
  } finally { cdp?.close(); }
}

export const chromeVersion = () => withChrome(async (cdp) => (await cdp.send('Browser.getVersion')).product).catch(() => null);

/** Closes the tabs on `origin`'s run pages, except those panes show. Returns how many it closed. */
export function closeRunTabs(origin) {
  return withChrome(async (cdp) => {
    const keep = new Set(listPanes().map((p) => p.targetId));
    const { targetInfos } = await cdp.send('Target.getTargets');
    let n = 0;
    for (const t of targetInfos) {
      if (t.type !== 'page' || keep.has(t.targetId) || !t.url.startsWith(`${origin}/r/`)) continue;
      try { await cdp.send('Target.closeTarget', { targetId: t.targetId }); n++; } catch {}
    }
    return n;
  }).catch(() => 0);
}
