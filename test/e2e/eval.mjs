// Evaluates an expression in the test page (the tab whose address starts with data:) and prints it.
import { connect } from '../../src/cdp.mjs';
const cdp = await connect({ autostart: false });
await cdp.ready();
const { targetInfos } = await cdp.send('Target.getTargets');
const t = targetInfos.filter((t) => t.type === 'page' && t.url.startsWith(process.argv[3] || 'data:')).pop();
if (!t) { console.log('NO-TAB'); process.exit(0); }
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
const r = await cdp.send('Runtime.evaluate', { expression: process.argv[2] }, sessionId);
console.log(String(r.result.value));
cdp.close();
