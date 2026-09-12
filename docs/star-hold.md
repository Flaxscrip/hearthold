# Star Hold: City Key v1 import contract

Initial compatibility contribution for [issue #90](https://github.com/Flaxscrip/hearthold/issues/90).
Status: local JSON import and hash conformance implemented; credential verification,
identity binding, transport and Warden authorization remain follow-up work.

## The boundary

Star presents; Hearthold verifies and enforces. The Star Hold **artefact** retains
original signed envelopes beside a City Key. A future Hearthold Star Hold
**CapabilityModule** receives an approved presentation. Neither an imported key,
a matching hash, a rendered vertex nor a count grants access.

`importCityKeyV1(json)` from `@hearthold/core` returns the parsed key, the original
JSON string, its re-derived digest, `integrity: matched | unlabelled` and
`authority: unverified`. A mismatched or malformed label throws. It does not stamp
an unlabelled input. Keep `originalJson` for unchanged re-export; serializing a
modified `key` is a new export and needs the caller's explicit evolution policy.
The function performs no IO or network calls and is not wired to an admission path.

## Accepted carrier profile

This is a compatibility profile for maintainer review, not a replacement for all
producers' schemas. The [agentprivacy City Key type](https://github.com/mitchuski/agentprivacy/blob/main/src/lib/city-key.ts)
and Hearthold's `game42ToCityKey` differ: the latter can omit descriptions and
always supplies several fields that the former makes optional. Keep its existing
`CityKey` producer type; use `ImportedCityKeyV1` for carried documents.

- Required: `version` exactly `1`, string `name`, and a `palette` object with
  string `cool`, `warm`, `sword`, `mage` fields. Palette strings are not validated
  for use as CSS: a renderer must apply its own display validation.
- Optional `descriptions`: string-valued object. Its omission preserves existing
  Hearthold exports; no default is inserted.
- Optional `kappa` and `prior`: `sha256:` followed by 64 lowercase hexadecimal digits.
- Optional experimental `holds`: digest `root` and non-negative safe-integer
  `count`. This checks the commitment slot's shape, **not** its root construction,
  retained items, signatures, holder binding or count truthfulness.
- All other fields, including unknown fields inside recognized objects, are
  retained and hashed. They are opaque content, not validated capabilities.

Input is limited to 1 MiB of UTF-8 and 64 nested levels. Parsed numbers must be
finite, including in opaque extensions. The API accepts JSON text using ECMAScript
`JSON.parse` semantics (including last-member-wins for duplicate object names);
it makes no claim to preserve duplicate members in the parsed object. Producers
should emit unique member names. The original text remains available unchanged.
PNG decoding is outside this slice: a carrier decoder supplies the extracted JSON
to this same boundary and must be tested separately before PNG import is exposed.

## Canonical bytes and lineage

Use the existing `cityCanonical` / `cityKappa`, not Game of 42's separate
`canonical` / `kappaLabel` (which have different exclusions).

```text
content = shallow copy of parsed key, with only top-level kappa removed
canonical = recursive object-key sort; arrays retain order;
            JSON.stringify for keys and primitives; compact separators
kappa = "sha256:" + lowercase hex(SHA-256(UTF-8(canonical)))
```

Sorting and primitive encoding follow ECMAScript. This profile is not implicitly
JCS or a credential cryptosuite's signed-byte algorithm. Unknown fields, nested
`kappa`, `prior`, `holds`, `seal` and other content are included. An unchanged
import/export must not add defaults or advance lineage. A receipt should name the
pre-encounter key; an explicitly authorized fold can then commit the receipt and
set `prior` before deriving the next key. Import itself performs no fold.

The synthetic [vectors](../demos/star-hold/city-key-v1.vectors.json) pin canonical
strings and digests independently generated with Python for the represented
values. They cover minimal legacy output, Unicode, nested label fields, unknown
extensions, arrays, lineage and the experimental Hold slot. They are portable
producer/consumer fixtures, not private records. They do not exhaust ECMAScript
number or Unicode edge cases.

```sh
node --experimental-strip-types --test packages/core/test/game42-city-key.test.ts
```

The check runs offline using Node >=22, without a wallet or Archon node. The
repository's `npm run test:unit` also discovers it.

## Subsequent reviewable slices

1. **Retained Hold verification.** Agree the envelope/profile contract and root
   algorithm; retain original signed bytes and recheck each item's signature and
   current status. Keep invalid, unsupported and unavailable distinct. Start with
   synthetic suite fixtures, then the explicitly shared Hearthold acceptance
   credential. A `did:cid` / secp256k1 envelope requires the actual resolver and
   suite verifier; transporting it is not verification.
2. **One authorized encounter.** Bind a fresh challenge to a verified holder,
   audience, action, resource, expiry and the agreed content state. Keep κ (a
   content address) distinct from `did:cid` identity and from delegation. The
   Emissary transports, the Warden authors consent and enforces release, and the
   Sovereign authorizes policy. No subject identifier before approval. Test replay,
   expiry, revocation, wrong audience, refusal and receipt retention against the
   real enforcement path before offering KB admission or a scoped capability.
3. **Private community presentation.** A k-of-n vouch statement needs separately
   checked membership, issuer linkage, signature validity, distinctness, holder
   binding, revocation and transcript binding. Raw κ, Hold root and exact count
   can correlate encounters and must not be automatically disclosed. A local
   reference relation is not a ZK circuit or proof of unlinkability; circuit cost,
   proof bytes and the adversary model remain to be established. A policy
   threshold must not become an emitted reputation score.

The Star-side producer should consume the same published fixtures. Agreement on
the identity-binding and encounter schema in #90 remains a separate design
decision; this PR does not choose or mint an Archon identity.

## Hearthold's place in the collaboration

The agentprivacy harness map seats the Hearthold identity/custody workshop at
V60 (Protection, Delegation, Memory, Connection), with complementary anchor V3
(Computation, Value). This is descriptive placement, not protocol authority.
Hearthold's disclosure-debt method also informs the local Star Hold work: measure
what a relying party learns against a frozen requirement census, separately from
what the holder stores and what a proof transports. The useful shared output is
a reproducible check; governance and release decisions stay with their owners.
