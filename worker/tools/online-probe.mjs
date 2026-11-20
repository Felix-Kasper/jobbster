// Jobbster · Diagnose: Sind diese Anzeigen noch online? Ohne KI, schreibt nichts.
// Start: node worker/tools/online-probe.mjs "url1,url2,…"
import { anzeigeStatus } from '../lib/online.mjs';
const urls = String(process.argv[2] || '').split(',').map((u) => u.trim()).filter(Boolean);
for (const url of urls) {
  const t0 = Date.now();
  const b = await anzeigeStatus(fetch, url);
  console.log(`${b.status.padEnd(7)} ${String(Date.now() - t0).padStart(5)} ms  ${b.grund}  ${url}`);
}
