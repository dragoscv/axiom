import type { Finding } from "@codai/axiom-schema";
import { z } from "zod";
import { definePredicate } from "../types.js";
import { finding, globMatcher, isUtf8 } from "./util.js";

/** Luhn checksum over a digit string (ISO/IEC 7812-1); every real PAN passes it. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const CARD_RE = /(?<![\w-])(?:\d[ -]?){12,15}\d(?![\w-])/g;

/**
 * Payment-card numbers (13–16 digits, optional single space/hyphen separators).
 * S-408: a 16-digit run is only a PAN when it passes Luhn and is not a single
 * repeated digit (`0000…`, `1111…` — placeholders, some of which are Luhn-valid),
 * and digit runs that are part of a UUID (`00000000-0000-0000-0000-000000000000`)
 * are never PANs. Metu's zero-UUID test ids tripped the old bare regex.
 */
export function findCardNumber(text: string): boolean {
  const scrubbed = text.replace(UUID_RE, (m) => " ".repeat(m.length));
  CARD_RE.lastIndex = 0;
  for (let m = CARD_RE.exec(scrubbed); m !== null; m = CARD_RE.exec(scrubbed)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 16) continue;
    if (/^(\d)\1+$/.test(digits)) continue;
    if (luhnValid(digits)) return true;
  }
  return false;
}

/**
 * Romanian CNP (13 digits): `S AA LL ZZ JJ NNN C`. S-414 corpus scan: the bare `[1-9]\d{12}`
 * regex matched 15 files in 30 OSS repos — epoch-millis timestamps, ISBN-13s, big-int test
 * vectors. A real CNP has S ∈ 1..9, a valid month/day, a county code 01–52 (or 70), and a
 * control digit = (Σ digit_i × w_i) mod 11 with weights 279146358279 (10 → 1).
 */
export function cnpValid(digits: string): boolean {
  if (!/^[1-9]\d{12}$/.test(digits)) return false;
  const mm = Number(digits.slice(3, 5));
  const dd = Number(digits.slice(5, 7));
  const jj = Number(digits.slice(7, 9));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
  if (!((jj >= 1 && jj <= 52) || jj === 70)) return false;
  const w = "279146358279";
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (digits.charCodeAt(i) - 48) * (w.charCodeAt(i) - 48);
  const c = sum % 11 === 10 ? 1 : sum % 11;
  return c === digits.charCodeAt(12) - 48;
}

const CNP_RE = /\b[1-9]\d{12}\b/g;
export function findCnp(text: string): boolean {
  CNP_RE.lastIndex = 0;
  for (let m = CNP_RE.exec(text); m !== null; m = CNP_RE.exec(text)) {
    if (cnpValid(m[0])) return true;
  }
  return false;
}

/**
 * Email addresses that are not personal data: RFC 2606/6761 reserved domains, the git SSH
 * remote form (`git@github.com`), GitHub noreply/bot senders, and pseudo-addresses produced
 * by `@2x.png`-style asset names or decorators. S-414 corpus scan: 110/3240 OSS files
 * matched the bare regex — every one a maintainer `pyproject.toml` author, a CONTRIBUTING
 * `git@github.com`, or a docs `user@example.com`.
 */
const EMAIL_RE = /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const EMAIL_SKIP_DOMAIN =
  /(^|\.)(example\.(com|net|org)|example|test|invalid|localhost|localdomain)$|(^|\.)github\.com$/i;
const EMAIL_SKIP_LOCAL = /^(git|noreply|no-reply|donotreply|do-not-reply)$/i;
const EMAIL_SKIP_TLD_AS_EXT =
  /\.(png|jpe?g|gif|svg|webp|ico|css|js|ts|json|md|txt|html?|xml|yml|yaml|py)$/i;
export function findPersonalEmail(text: string): boolean {
  EMAIL_RE.lastIndex = 0;
  for (let m = EMAIL_RE.exec(text); m !== null; m = EMAIL_RE.exec(text)) {
    const local = m[1] ?? "";
    const domain = m[2] ?? "";
    if (EMAIL_SKIP_DOMAIN.test(domain)) continue;
    if (EMAIL_SKIP_LOCAL.test(local)) continue;
    if (EMAIL_SKIP_TLD_AS_EXT.test(domain)) continue;
    return true;
  }
  return false;
}

/**
 * `password = "…"`-style credential literals. S-414 corpus scan: the bare
 * `(password|secret|token|api_key)\s*[:=]\s*value` regex matched 107/3240 OSS files — every one
 * a type annotation (`token: str`), a variable holding a runtime value (`token = var.set(...)`,
 * `token = TrioBackend.current_token()`), a YAML permission (`token: write`) or a docstring.
 * A credential *literal* is a quoted string of ≥ 8 chars that is not a placeholder, an
 * interpolation, or a template.
 */
const CRED_RE =
  /(?:^|[^A-Za-z0-9])[A-Za-z0-9_-]*?(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*(?:new\s+\w+\s*\(\s*)?(["'`])([^"'`\r\n]{8,})\2/gi;
const CRED_PLACEHOLDER =
  /^(\$\{|\{\{|<|%[(sd]|\$[A-Z_]|xxx|\*{3,}|\.{3,}|change[_-]?me|replace[_-]?me|your[_-]|my[_-]?(actual[_-]?)?(password|secret|token|key)|placeholder|example|dummy|sample|test(value|ing)?$|redacted|hunter2$|password$|secret$|123456)/i;
export function findCredentialLiteral(text: string): boolean {
  CRED_RE.lastIndex = 0;
  for (let m = CRED_RE.exec(text); m !== null; m = CRED_RE.exec(text)) {
    const value = m[3] ?? "";
    if (CRED_PLACEHOLDER.test(value)) continue;
    // Identifier-shaped values (`libsecret = "keyring.backends.libsecret"`, `TOKEN = "REVISION_SCRIPT_FILENAME"`).
    if (/^[a-z_][a-z0-9_.]*$/i.test(value) && !/\d/.test(value)) continue;
    return true;
  }
  return false;
}

/**
 * Named patterns. `secret` patterns run by default; `pii` patterns (Romanian CNP, e-mail,
 * Romanian phone, payment card) only when the check sets `pii: true` (S-414: PII in an OSS
 * tree — maintainer e-mails, ISBNs, epoch millis — is not a reason to refuse a write; the
 * invoicing/GDPR profiles that need it opt in explicitly).
 */
export const SECRET_PATTERNS: ReadonlyArray<{
  name: string;
  kind: "secret" | "pii";
  re?: RegExp;
  test?: (text: string) => boolean;
}> = [
  { name: "cnp", kind: "pii", test: findCnp },
  { name: "email", kind: "pii", test: findPersonalEmail },
  { name: "phoneRo", kind: "pii", re: /\b(\+4|0)7\d{8}\b/ },
  { name: "card", kind: "pii", test: findCardNumber },
  { name: "credentialAssignment", kind: "secret", test: findCredentialLiteral },
  { name: "awsKey", kind: "secret", re: /AKIA[0-9A-Z]{16}/ },
  { name: "githubToken", kind: "secret", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "privateKey", kind: "secret", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "jwt", kind: "secret", re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
  { name: "slackToken", kind: "secret", re: /xox[abpr]-/ },
];

export const SECRET_PATTERN_NAMES: readonly string[] = SECRET_PATTERNS.map((p) => p.name);
export const PII_PATTERN_NAMES: readonly string[] = SECRET_PATTERNS.filter(
  (p) => p.kind === "pii",
).map((p) => p.name);

/** Max bytes scanned per artifact; longer content is scanned as a prefix. */
const SCAN_LIMIT = 4 * 1024 * 1024;

const NoSecretsParams = z
  .object({
    disable: z.array(z.string()).default([]),
    allowPaths: z.array(z.string().min(1)).default([]),
    /** Also scan for personal data (`cnp`, `email`, `phoneRo`, `card`). Default off. */
    pii: z.boolean().default(false),
  })
  .strict();

export const contentNoSecrets = definePredicate<z.infer<typeof NoSecretsParams>>({
  id: "content.noSecrets",
  params: NoSecretsParams,
  requires: ["manifest", "content"],
  async run(ctx, { disable, allowPaths, pii }) {
    const skip = globMatcher(allowPaths, false);
    const active = SECRET_PATTERNS.filter(
      (p) => !disable.includes(p.name) && (pii || p.kind === "secret"),
    );
    const out: Finding[] = [];
    const decoder = new TextDecoder("utf-8", { fatal: false });
    for (const a of ctx.manifest.artifacts) {
      if (a.op === "delete" || skip(a.path)) continue;
      const bytes = await ctx.facts.content(a.path);
      if (bytes === undefined) continue;
      const text = decoder.decode(bytes.subarray(0, SCAN_LIMIT));
      for (const p of active) {
        const hit = p.test !== undefined ? p.test(text) : (p.re?.test(text) ?? false);
        if (!hit) continue;
        out.push(
          finding({
            id: `content.noSecrets.${p.name}`,
            predicate: "content.noSecrets",
            path: a.path,
            message: `content matches secret/PII pattern "${p.name}"`,
            facts: { pattern: p.name },
          }),
        );
      }
    }
    return out;
  },
});

const MaxBytesParams = z
  .object({ max: z.int().nonnegative(), globs: z.array(z.string().min(1)).optional() })
  .strict();

export const contentMaxBytes = definePredicate<z.infer<typeof MaxBytesParams>>({
  id: "content.maxBytes",
  params: MaxBytesParams,
  requires: ["manifest"],
  async run(ctx, { max, globs }) {
    const applies = globMatcher(globs, true);
    const out: Finding[] = [];
    for (const a of ctx.manifest.artifacts) {
      if (a.op === "delete" || !applies(a.path)) continue;
      let bytes = a.bytes;
      if (bytes === undefined) bytes = (await ctx.facts.content(a.path))?.length;
      if (bytes === undefined || bytes <= max) continue;
      out.push(
        finding({
          id: "content.maxBytes",
          predicate: "content.maxBytes",
          path: a.path,
          message: `artifact is ${bytes} bytes, limit ${max}`,
          facts: { bytes, max },
        }),
      );
    }
    return out;
  },
});

const EncodingParams = z.object({ globs: z.array(z.string().min(1)).optional() }).strict();

export const contentEncodingUtf8 = definePredicate<z.infer<typeof EncodingParams>>({
  id: "content.encodingUtf8",
  params: EncodingParams,
  requires: ["manifest", "content"],
  async run(ctx, { globs }) {
    const applies = globMatcher(globs, true);
    const out: Finding[] = [];
    for (const a of ctx.manifest.artifacts) {
      if (a.op === "delete" || !applies(a.path)) continue;
      const bytes = await ctx.facts.content(a.path);
      if (bytes === undefined || isUtf8(bytes)) continue;
      out.push(
        finding({
          id: "content.encodingUtf8",
          predicate: "content.encodingUtf8",
          path: a.path,
          message: "artifact content is not valid UTF-8",
        }),
      );
    }
    return out;
  },
});
