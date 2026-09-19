# Signing manifests (DSSE, Ed25519) — D-16

A `ManifestBundle` can carry detached **DSSE v1.0.2** envelopes over its canonical
`manifest`. A root that keeps a trust store under `.axiom/trust/` can then require, via
the `manifest.requireSigned` predicate, that every bundle it applies was signed by a
pinned key and — optionally — that its `counter` is strictly newer than the last one
applied (anti-rollback). Nothing about `manifestDigest` changes when a bundle is signed.

## Threat model

What signing defends against:

| Threat | Defence |
|--------|---------|
| An agent, a compromised harness, or a person edits a manifest *after* it was reviewed/produced by the trusted pipeline | Every byte of the canonical body is under the signature. Any change → `signature.bad` / `signature.notCanonical`; `apply` refuses (`ERR_CHECKS_FAILED`). |
| A bundle signed by a key the root does not know | `signature.unknownKey`. Keys are an explicit per-root allowlist (`keys.json`); there is no "any valid key" mode. |
| Replaying an **older**, legitimately signed bundle to undo a newer one | `antiRollback`: the body carries a monotonic `counter`; the root remembers `lastCounter` and rejects `counter ≤ lastCounter` (`signature.rollback`). |
| A leaked private key | Remove its entry from `keys.json` (`axiom trust remove`). `notBefore` on a new key lets you refuse counters that predate its issuance. |
| Signature presence used as proof of review | Presence is *not* verification: `facts.manifest.signed` only says "has envelopes"; `manifest.requireSigned` is what verifies. |

What it deliberately does **not** defend against:

- **Cross-root replay, unless you bind.** By default the root is *not* in the payload (a
  manifest is root-relative by design, so one signed bundle may legitimately be applied to
  several clones). A bundle signed for repo A is then a valid signed bundle for repo B if B
  trusts the same key. **S-409 closes this when you opt in**: set a `rootId` on the trust
  store (`axiom trust root-id github:org/repo --root .`) and sign with `--root-id`; the
  store then accepts only envelopes bound to that id (see *Root-bound signatures*).
- **Key compromise before revocation.** Whatever the key signs until you remove it is
  trusted.
- **Availability.** A missing or corrupt trust store fails **closed**
  (`verdict: error`), never open.
- **Confidentiality.** Manifests and blobs are not encrypted; signing is integrity only.

## Envelope

```json
{
  "payloadType": "application/vnd.axiom.manifest+json",
  "payload": "<base64( JCS(manifest) )>",
  "signatures": [
    { "keyid": "<hex sha256(raw 32-byte public key)>", "sig": "<base64 Ed25519 signature>" }
  ]
}
```

- `payload` = base64 of the **JCS (RFC 8785)** serialisation of `ManifestBody` — the exact
  bytes whose sha256 is `manifestDigest`. On verify, the payload must be byte-identical to
  `JCS(JSON.parse(payload))` (`NOT_CANONICAL` otherwise) and must hash to the bundle's
  `manifestDigest` (`PAYLOAD_MISMATCH` → `signature.bad`).
- Signature input is the DSSE **PAE**:
  `"DSSEv1" SP len(payloadType) SP payloadType SP len(payload) SP payload`
  with decimal byte lengths and the *decoded* payload bytes.
- `keyid` is an **unauthenticated hint** (per the DSSE spec). Verification tries every
  trusted key; a wrong or missing `keyid` does not fail a genuine signature, and a matching
  `keyid` with a forged `sig` is `BAD_SIGNATURE`, not `UNKNOWN_KEY`.
- Envelopes live in `bundle.signatures[]`, **outside** the canonical body. Multiple
  envelopes (one per signer) are allowed; `minSignatures` counts *distinct trusted keys*.

The in-toto attestation (`bundle.attestation` / `bundle.envelope`,
`application/vnd.in-toto+json`) is a separate, unsigned-by-default record and is not what
`manifest.requireSigned` verifies.

## Keys

- Algorithm: **Ed25519 only** (`node:crypto`, no dependency).
- `keyid` = lowercase hex of `sha256(raw 32-byte public key)`, full 64 chars.
- Trust store — `<root>/.axiom/trust/keys.json`:

  ```json
  {
    "version": 1,
    "keys": [
      { "keyid": "…64 hex…", "alg": "ed25519", "publicKey": "<base64 raw 32 bytes>", "name": "ci", "notBefore": 0 }
    ],
    "minCounter": 0
  }
  ```

  `name` is a label; `notBefore` (optional) is the lowest `counter` the key may sign for;
  `minCounter` (optional) is the floor used before any state exists. `axiom trust add`
  re-derives the `keyid` from `publicKey` and refuses entries where they disagree.

- Anti-rollback state — `<root>/.axiom/trust/state.json`:

  ```json
  { "version": 1, "lastCounter": 7, "manifestDigest": "sha256:…" }
  ```

  Written with write-temp + rename, **only** when `apply` returns `status: "applied"`
  and the effective checks include `manifest.requireSigned { antiRollback: true }`.
  Dry runs, no-ops, failures and rollbacks never touch it. It is monotonic: a lower
  counter never overwrites a higher one.

- Private keys are read **only** from:
  - `AXIOM_SIGNING_KEY` — base64 PKCS#8 DER, base64 raw 32-byte seed, or PEM text; or
  - `--key-file <path>` — same formats (wins over the env var).

  They are never written under a root, never stored in the trust store and never printed.
  `axiom keygen` writes the private key to a file with mode `0600` and prints only the
  public entry and the file path.

## Root-bound signatures (S-409)

A second `payloadType`, `application/vnd.axiom.manifest-bound+json`, signs
`JCS({ manifest, rootId })` instead of `JCS(manifest)`. `rootId` is an operator-chosen
identity for the target (`github:dragoscv/brivio`, a UUID, …; `[A-Za-z0-9][A-Za-z0-9._:/@-]*`,
≤ 200 chars). `manifestDigest` is unchanged — the binding lives in the envelope only.

| trust store | unbound envelope | bound to `rootId` X | bound to another root |
|---|---|---|---|
| no `rootId` | accepted | accepted | accepted |
| `rootId: X` | `signature.unbound` (`UNBOUND`) | accepted | `signature.unbound` (`ROOT_MISMATCH`) |

Verification of a bound envelope re-derives the inner manifest's JCS digest and requires it to
equal `manifestDigest` (transplanting a bound envelope onto another manifest is
`signature.bad`), then compares `rootId` to the store's before checking the Ed25519 signature.

```sh
axiom trust root-id github:dragoscv/brivio --root /repo     # bind the store (idempotent)
axiom trust root-id --root /repo                            # show
axiom sign bundle.json --key-file k.key --root-id github:dragoscv/brivio
axiom trust root-id --clear --root /repo                    # back to "any"
```

When the same manifest must be applied to several roots, sign it once per root (the
envelopes coexist in `signatures[]`; each store verifies only its own).

## Authenticated trust state (S-409)

`advanceTrustState` (after every `status: "applied"`) creates `.axiom/trust/state.key` (32
random bytes, hex, mode `0600`) on first use and writes `state.json` with
`mac = HMAC-SHA256(state.key, JCS(state without mac))`. Whenever a `state.key` exists, both
the predicate and the CLI/MCP refuse a `state.json` whose MAC is missing or wrong
(`ERR_TRUST_STATE_CORRUPT`, `reason: NO_MAC | BAD_MAC`) — an attacker who can edit
`state.json` but not read `state.key` can no longer lower `lastCounter` to replay an old
bundle. Roots without a `state.key` (created before 2.2) keep working unauthenticated until
their next apply creates one. Protect `state.key` like the trust store itself; never commit
it. `axiom trust reset` style removal of `state.json` keeps the key.

## CI key ceremony

The private key must never exist on a developer machine that also runs the agent.

1. On a clean runner (or an ephemeral container): `axiom keygen --out ./k --name ci-<repo>`.
   Copy the **file contents** into a GitHub **repository secret** `AXIOM_SIGNING_KEY`
   (Settings → Secrets and variables → Actions), then delete `./k`. The public entry
   (`publicEntry` on stdout) is the only thing that leaves the runner.
2. Commit the public entry: `axiom trust add ci-pub.json --root .` and, if you want binding,
   `axiom trust root-id github:<owner>/<repo> --root .`. Commit `.axiom/trust/keys.json`; never
   commit `state.json`, `state.key` or any `*.key`.
3. In the signing job:

   ```yaml
   - run: axiom sign bundle.json --root-id github:${{ github.repository }}
     env:
       AXIOM_SIGNING_KEY: ${{ secrets.AXIOM_SIGNING_KEY }}
   ```

   `sign` reads the key from the env var only in that step; nothing is written to disk and
   the CLI never prints key material. Restrict the secret to a protected environment
   (`environment: release`) so pull requests from forks cannot use it.
4. Rotation: `keygen` a new key, `trust add` it with `notBefore: <current counter + 1>`,
   update the secret, `trust remove` the old keyid. Whatever the old key signed before
   removal stays applied; `notBefore` stops the new key from being used to replay old
   counters.
5. Compromise: `trust remove <keyid>` first (blocks further applies), then rotate.

## Anti-rollback counter

`Plan.counter` (int ≥ 0, optional) is copied verbatim into `ManifestBody.counter`, so it is
inside both `planDigest` and `manifestDigest` and therefore under the signature. Pick any
monotonic source: a CI run number, a Unix timestamp, a release sequence.

`manifest.requireSigned { antiRollback: true }` requires the counter to be present and

`counter > state.lastCounter` (when state exists) and `counter ≥ keys.minCounter` (when set).

### Differences from `acceptManifest` (codai `rules-core/envelope.ts`, the ported source)

`rules-core` accepts `version > current.version`, treats **equal version + same hash** as an
idempotent re-accept, rejects **equal version + different hash** as `TAMPERED`, and adds
`EXPIRED` (`expires_at` vs a clock) and `UNBOUND` (device manifest not bound to the account
manifest hash). AXIOM keeps only the monotonic rule and makes it strict:

| rules-core | AXIOM `manifest.requireSigned { antiRollback }` | Why |
|-----------|-----------------------------------------------|-----|
| `version < current` → `ROLLBACK` | `counter ≤ lastCounter` → `signature.rollback` (`ROLLBACK`) | Re-applying the same counter is rejected too; AXIOM's own idempotency lives in `apply` (`status: noop` on an identical, already-applied digest), so the check does not need the same-hash carve-out. Equal counter + different body is therefore also rejected — the `TAMPERED` case collapses into `ROLLBACK`. |
| `EXPIRED` | none | Nothing hashed may depend on a clock (PLAN.md §2); expiry would belong in a profile predicate, not the body. |
| `UNBOUND` | none | Single-manifest model; there is no account/device pair. |
| state = last `{version, hash}` kept "where the agent cannot write" | `.axiom/trust/state.json` `{lastCounter, manifestDigest}`, advanced **only** after `status: "applied"` | A failed or rolled-back apply must not burn a counter. |
| `notBefore` — | `TrustedKey.notBefore`, `TrustStore.minCounter` | Lets a rotated key refuse counters that predate it, and lets a fresh root start above zero. |

## Predicate

```json
{
  "id": "manifest.requireSigned",
  "predicate": "manifest.requireSigned",
  "params": { "minSignatures": 1, "antiRollback": true, "trustFile": ".axiom/trust/keys.json" },
  "severity": "error"
}
```

| Finding id | Meaning |
|------------|---------|
| `signature.missing` | no envelopes, or fewer than `minSignatures` distinct trusted keys verified |
| `signature.unknownKey` | an envelope verifies under no trusted key (`facts.hinted` lists the `keyid` hints) |
| `signature.bad` | signature does not verify under the hinted key, or the payload does not hash to `manifestDigest` (`facts.reason: PAYLOAD_MISMATCH`) |
| `signature.notCanonical` | payload is not byte-identical to its own JCS form |
| `signature.rollback` | `antiRollback` and: no `counter` (`NO_COUNTER`), `counter ≤ lastCounter` (`ROLLBACK`), or `counter < minCounter` (`BELOW_MIN`) |
| `signature.unbound` | the store has a `rootId` and the envelope is unbound (`UNBOUND`) or bound to another root (`ROOT_MISMATCH`) |

Provider errors (`verdict: error`, never pass): no root, trust file missing
(`ERR_NOT_FOUND`), unreadable/invalid trust file (`ERR_PROVIDER_FAILED`), corrupt
`state.json` (`ERR_TRUST_STATE_CORRUPT`). `axiom verify --root` / `axiom_manifest_verify`
report `signatures.code`: `ERR_SIGNATURE_MISSING` when the bundle carries no signature
at all, `ERR_SIGNATURE_INVALID` for every other failure.

## CLI walkthrough

```sh
# 1. Generate a signing key (once, on the machine/CI that signs)
axiom keygen --out ./secrets --name ci > ci-pub.json
#   → stdout: { "publicEntry": {keyid, alg, publicKey, name}, "privateKeyFile": "./secrets/axiom-signing-<id>.key" }
#   the .key file is mode 0600 and is the ONLY copy of the private key

# 2. Pin the public key in the target repo
axiom trust add ci-pub.json --root /repo
axiom trust list --root /repo

# 3. Compile a plan that carries a counter, then sign
axiom compile plan.json -o bundle.json            # plan.json has "counter": 42
axiom sign bundle.json --key-file ./secrets/axiom-signing-<id>.key
#   or:  AXIOM_SIGNING_KEY=<base64> axiom sign bundle.json -o signed.json

# 4. Verify (structure + signatures against the root's trust store)
axiom verify bundle.json --root /repo
#   → { ok, signed: true, signatures: { trustFile, keyids: [...], findings: [], ok: true } }

# 5. Enforce at apply time with a profile that requires it
#   /repo/.axiom/profiles/signed.json:
#   { "apiVersion":"axiom.dev/v2","kind":"Profile","name":"signed",
#     "checks":[{"id":"manifest.requireSigned","predicate":"manifest.requireSigned",
#                "params":{"antiRollback":true},"severity":"error"}] }
axiom check bundle.json --root /repo --profile signed
axiom apply bundle.json --root /repo --profile signed --confirm sha256:<digest>
#   → applied; .axiom/trust/state.json now has lastCounter: 42
#   re-applying any bundle with counter ≤ 42 → signature.rollback → ERR_CHECKS_FAILED

# Revoke
axiom trust remove <keyid> --root /repo
```

Over MCP, `axiom_manifest_verify { bundle, root }` reports the same `signatures` block and
`axiom_apply` advances the state under the same conditions as the CLI.

## Limitations

- Ed25519 only; no RSA/ECDSA, no certificates, no Sigstore/Fulcio, no timestamps.
- Root binding is opt-in (`rootId` on the store); an unbound store accepts any root.
- `state.json` is authenticated by a per-root `state.key`, not signed by the trust keys: an
  attacker who can read **and** write `.axiom/trust/` can still delete both files and start
  the counter over — `minCounter` on the store bounds that. The trust directory needs the same
  protection as the repository's CI configuration.
- Key rotation is add/remove + `notBefore` (ceremony above); no automatic expiry.
