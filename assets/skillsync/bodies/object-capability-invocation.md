# Object-capability invocation

Authority as a **signed, scoped, revocable capability object** — verified at the point of use, never a role
or a standing permission. The lifecycle is **mint → delegate (narrowing only) → invoke → revoke**.

## When to use

- An agent must act on another's behalf with authority that is explicit, auditable, and withdrawable.
- You need to rule out the confused-deputy problem structurally, not by convention.

## How it works (Alan Karp's ocap model on `did:cid`)

- **Designation is authority.** The invocation names its resource; there is no ambient lookup that could be
  tricked into acting on the wrong one.
- **Attenuation is monotonic.** A delegated capability can only **narrow**. Widening is refused at issuance
  and is unrepresentable in a verified chain — so there is no confused deputy.
- **Chains verify** origin, subset-narrowing per hop, and **per-hop revocation** (fail-closed): revoking any
  hop invalidates everything downstream.
- **Invoked, then checked.** The holder presents the capability; the reference monitor re-verifies the whole
  chain at the point of use.

## Invariants

- No standing permissions; authority is a capability you hold, not a role you are.
- Revocation is immediate and fail-closed.
- The audience is designated by the capability, never chosen at invoke time.

Reference: `docs/invocation.md`, `core/capability.ts`, `core/attenuation.ts`, `core/capability-chain.ts`,
`core/invocation-monitor.ts`.
