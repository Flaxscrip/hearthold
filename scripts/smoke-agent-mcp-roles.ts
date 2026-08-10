/**
 * smoke: the per-actor MCP tool profiles (Phase 3). Pure logic — no node/keymaster needed.
 * Verifies the role → verb-set partition, the forge→invoke migration (audit-4), and profile integrity.
 *
 *   node --experimental-strip-types scripts/smoke-agent-mcp-roles.ts
 */
import { HEARTHOLD_TOOLS, toolsForRole } from '@hearthold/agent-mcp/tools';

const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  line(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const names = (role: Parameters<typeof toolsForRole>[0]): string[] => toolsForRole(role).map((t) => t.name);

line('\n════ per-actor MCP tool profiles ════');

const all = new Set(HEARTHOLD_TOOLS.map((t) => t.name));

// audit-4: the stale forge (→ removed /api/forge) is gone; invoke (→ /api/invoke) replaces it.
check('hearthold_forge is retired (no longer POSTs the removed /api/forge)', !all.has('hearthold_forge'));
check('hearthold_invoke exists (the capability invocation path)', all.has('hearthold_invoke'));

// full = every tool (back-compat: the original agent-as-principal set).
check('role=full exposes all tools', toolsForRole('full').length === HEARTHOLD_TOOLS.length);

for (const role of ['warden', 'sovereign', 'emissary', 'verifier'] as const) {
  const ns = names(role);
  check(`role=${role} is a non-empty subset of the tool set`, ns.length > 0 && ns.every((n) => all.has(n)), ns.join(', '));
}

// each actor's signature verbs land in the right profile
check('emissary → invoke + accept_capability + contribute', ['hearthold_invoke', 'hearthold_accept_capability', 'hearthold_contribute'].every((n) => names('emissary').includes(n)));
check('sovereign → grant_capability + decline-only (no MCP tool can APPROVE a human gate — façade not bypass)', ['hearthold_grant_capability', 'hearthold_decline'].every((n) => names('sovereign').includes(n)) && !names('sovereign').includes('hearthold_decide'));
check('warden → delegate + recall + triage', ['hearthold_delegate', 'hearthold_recall', 'hearthold_triage'].every((n) => names('warden').includes(n)));
check('verifier → verify_card', names('verifier').includes('hearthold_verify_card'));

// separation: the invoke verb is NOT in the warden/sovereign/verifier profiles (it's the Emissary's)
check('invoke is scoped to the Emissary (not warden/sovereign/verifier)', !['warden', 'sovereign', 'verifier'].some((r) => names(r as 'warden').includes('hearthold_invoke')));
// grant is the Sovereign's alone
check('grant_capability is scoped to the Sovereign', !['warden', 'emissary', 'verifier'].some((r) => names(r as 'warden').includes('hearthold_grant_capability')));

line(`\n${failures === 0 ? '✅ ALL PASS — the per-actor profiles partition cleanly' : `❌ ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
