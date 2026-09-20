---
"@codai/axiom-checks": minor
"@codai/axiom-axm-lsp": minor
"@codai/axiom-mcp": minor
---

New predicate `expr.cedar` (S-411, D-25): Cedar policies over the same facts
`expr.cel` sees.

- **checks**: `expr.cedar { policies, mode?: "forbid" | "permit", message?,
  severity? }` runs one Cedar `isAuthorized` request per artifact — principal
  `Axiom::Plan::"<name>"`, action `Axiom::Action::"<op>"`, resource
  `Axiom::Artifact::"<path>"` (attrs `path`, `op`, `mode`, `ext`, `dir`, and
  when present `sha256`, `bytes`, `origin`, `text`, `exists`), parent
  `Axiom::Manifest::"<digest>"`, context `{ manifest, repo? }`. `mode: forbid`
  (default) appends a permit-all so every `deny` is a per-path finding;
  `mode: permit` is default-deny. Evaluated by `@cedar-policy/cedar-wasm`
  4.13 declared as an **optional** dependency and imported lazily; a host
  without it reports `ERR_PROVIDER_FAILED` (verdict `error`), never `pass`.
  Any Cedar evaluation error (missing attribute, type error, overflow) is a
  provider error — Cedar's "erroring policy does not apply" rule is not
  inherited. Templates, > 256 policies and parse errors →
  `ERR_PREDICATE_PARAMS`; 2 s wall-clock budget per manifest. 156-case
  hand-authored vector suite (`cedar-vectors.json`) + purity test.
- **axm-lsp**: `expr.cedar` completion/hover; 17 built-ins in parity.
- **mcp**: declares the same optional dependency so `npm i @codai/axiom-mcp`
  brings the WASM by default (`--no-optional` opts out; `expr.cedar` then
  fails closed).
- Docs: `docs/checks.md` §expr.cedar including the OWASP Agent Control
  Standard mapping (AXIOM = Guardian on the write channel; `allow`/`deny`
  only) and why OPA/Rego was not chosen.
