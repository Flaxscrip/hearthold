# Hearthold skill garden — `assets/skillsync/`

The publishable **Skill Sync** garden for Hearthold — the Play-1 handshake with the AgentPrivacy skill
garden ([skills.agentprivacy.ai](https://skills.agentprivacy.ai/); see
`docs/agentprivacy-skills-integration.md`).

## Layout

- `catalog.json` — the garden manifest: `{ handle, note, skills[] }`. Each skill is a neutral packet:
  `card` (≤280) · `brief` (≤1200) · `body` (path) · `bodyHash` (`sha256:…` of the body file).
- `bodies/*.md` — the full skill bodies, loaded on demand. **The `bodyHash` is the sha256 of the exact
  bytes of the body file** — re-derive it, never trust it by name (this is the same content-addressing
  discipline as `did:cid`).

## Verify (re-derive every hash)

```sh
node -e 'const c=require("./catalog.json"),cp=require("child_process");
for(const s of c.skills){const g="sha256:"+cp.execSync(`shasum -a 256 "${s.body}"`).toString().split(" ")[0];
console.log(s.name, g===s.bodyHash?"OK":"MISMATCH");}'
```

## What is confirmed vs proposed

- **Confirmed** against the public garden snapshot (2026-08-26): the packet spec (`card ≤280 · brief
  ≤1200 · sha256 body hash`), the publish path `assets/skillsync/catalog.json`, and registration via
  `POST /garden {handle, url, note}` (the Librarian fetches + verifies at the door, then chain-seals).
- **Proposed** (pending the Librarian's real schema): the per-skill JSON keys — `name`, `kind`, `card`,
  `brief`, `body`, `bodyHash`. The snapshot shows the spec and card/brief text, not the raw object keys, so
  these may need reconciling before registering. See the "What to ask PrivacyMage" section of the
  integration doc.

## To publish

Host this directory at `<hearthold-site>/assets/skillsync/`, then `POST /garden` at the Librarian with the
`hearthold` handle, the URL, and the one-line `note`. Nothing ever writes back to us.
