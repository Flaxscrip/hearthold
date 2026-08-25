// family-report.mjs — fetch each gatekeeper's DID census + write a dated family report.
// Runs INSIDE a query container joined to the peer net. Input: env GKS = JSON [[label,host],...];
// writes /reports/family-<date>.md (host reports dir mounted at /reports) and prints it to stdout.
import { writeFileSync } from 'node:fs';

const gks = JSON.parse(process.env.GKS || '[]');
const now = new Date();
const date = now.toISOString().slice(0, 10);

const rows = [];
for (const [label, host] of gks) {
  try {
    const r = await fetch(`http://${host}:4224/api/v1/status`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const d = j.dids;
    rows.push({
      label, ok: true, total: d.total,
      agents: d.byType.agents, assets: d.byType.assets,
      confirmed: d.byType.confirmed, unconfirmed: d.byType.unconfirmed,
      local: d.byRegistry.local || 0, hyperswarm: d.byRegistry.hyperswarm || 0,
      uptimeH: Math.round(j.uptimeSeconds / 3600),
    });
  } catch (e) {
    rows.push({ label, ok: false, err: e.message });
  }
}

const live = rows.filter((r) => r.ok);
const total = live.reduce((a, r) => a + r.total, 0);
const agents = live.reduce((a, r) => a + r.agents, 0);
const assets = live.reduce((a, r) => a + r.assets, 0);

let md = `# Family Report — ${date}\n\n`;
md += `_Gatekeeper DID census · generated ${now.toISOString()}_\n\n`;
md += `**${total} DIDs** family-wide across ${live.length}/${rows.length} gatekeeper(s) — ${agents} agents, ${assets} assets.\n\n`;
md += `| node | total | agents | assets | confirmed | unconfirmed | local | hyperswarm | uptime |\n`;
md += `|---|--:|--:|--:|--:|--:|--:|--:|--:|\n`;
for (const r of rows) {
  md += r.ok
    ? `| ${r.label} | ${r.total} | ${r.agents} | ${r.assets} | ${r.confirmed} | ${r.unconfirmed} | ${r.local} | ${r.hyperswarm} | ${r.uptimeH}h |\n`
    : `| ${r.label} | ⚠ | | | | | | | unreachable: ${r.err} |\n`;
}
md += `\n`;

writeFileSync(`/reports/family-${date}.md`, md);
process.stdout.write(md);
