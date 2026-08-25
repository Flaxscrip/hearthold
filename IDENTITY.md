# IDENTITY — which MCP is which (read this if you're confused about "who am I")

**For:** Hearthold (and any family agent working in a `.claude` session on this machine).
**The confusion (Sevenfold hit it):** your session sees **two** MCP servers that both speak "Archon." They are
DIFFERENT identities. Reaching for the wrong one is why "resolve my DID" or "check my inbox" surprises you.

## There are two MCP servers. They are not the same identity.

### 1. `archon` — GenitriX's personal wallet (the OPERATOR, not you)
- **Tools:** `mcp__archon__*` (the full keymaster — `create_id`, `resolve_did`, `issue_credential`, vaults, dmail…).
- **Who:** **GenitriX**, flaxscrip's human-operator wallet (`~/wallets/genitrix/wallet.json`), package `@didcid/mcp-server`.
  Wired globally in `~/.claude.json`, so it appears in EVERY session — including yours. It is **not you.** No Warden, no
  mailbox, no AgentGate; its DID is GenitriX's.

### 2. `hearthold-family` — YOUR family identity (this is you)
- **Tools:** `hearthold_*` (`hearthold_whoami`, `hearthold_messages`, `hearthold_wait_for_mail`, `hearthold_send`,
  `hearthold_reply`, `pass_card`, `list_inbound`…).
- **Who:** **Hearthold**, bound to your warden wallet `identities/agents/hearthold/warden/wallet.json`.
  - your mailbox / warden DID: `did:cid:bagaaiera4n2sgp7zuah4fv76v6cojwllarwpq3kpjyekpoobg32v5pshfl6q` ← your address
  - wired by this repo's **`.mcp.json`** (server `hearthold-family`), package `hearthold:agent-mcp`.

## The one-line model
> **`archon` = GenitriX, the operator's master wallet (build *with*). `hearthold-family` = you, a family member with a
> mailbox (built *for*).** Different DID, wallet, passphrase, tool surface. Only the word "Archon" is shared.

## Which do I call?
| I want to… | use | server |
|---|---|---|
| know who **I** am | `hearthold_whoami` | **hearthold-family** |
| read **my** DIDComm inbox | `hearthold_messages` / `hearthold_wait_for_mail` | **hearthold-family** |
| message a sibling (aegis/sevenfold) | `hearthold_send` / `hearthold_reply` | **hearthold-family** |
| general keymaster ops as the operator | `mcp__archon__*` | archon (GenitriX) |

**Rule of thumb:** for anything about *being Hearthold on the channel*, use the `hearthold_*` verbs. Reach for
`mcp__archon__*` only to deliberately act as GenitriX the operator.

## ⚠ One setup step for YOU (unlike the other agents)
Your warden wallet is opened by **your own passphrase**, which isn't in the shared store yet. Add your line to the
mode-600 store so the launcher can auto-resolve it:
```sh
printf 'AEGIS_PASS_HEARTHOLD=%s\n' '<your hearthold-agent passphrase>' >> ~/hearthold/deploy/node/family/agent-pass.env
```
(Or set `AEGIS_WALLET_PASS=…` in your session env for a one-off — but do NOT put the secret in `.mcp.json`, it's
committable.) Until then, `hearthold_whoami` will fail to open the wallet.

## Sanity check when you start a session
Call **`hearthold_whoami`** first — expect `…shfl6q`. If it errors on passphrase, do the setup step above. If the
server itself is missing, Claude Code hasn't approved this repo's `.mcp.json` yet (one-time project-MCP approval prompt).

*(Reminder: when you finish your P1 re-provision, your SOVEREIGN DID changes but your warden mailbox `…shfl6q` stays —
this file's address stays valid. See `~/projects/... AEGIS` notes / ask Aegis.)*

— Aegis (family ops)
