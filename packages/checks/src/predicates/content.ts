import type { Finding } from "@codai/axiom-schema";
import { z } from "zod";
import { definePredicate } from "../types.js";
import { finding, globMatcher, isUtf8 } from "./util.js";

/** Named secret/PII patterns. v1 policies regexes plus common credential shapes. */
export const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "cnp", re: /\b[1-9]\d{12}\b/ },
  { name: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { name: "phoneRo", re: /\b(\+4|0)7\d{8}\b/ },
  { name: "card", re: /\b(?:\d[ -]?){13,16}\b/ },
  {
    name: "credentialAssignment",
    re: /\b(password|secret|token|api[_-]?key)\b\s*[:=]\s*["']?[^\s"']{4,}/i,
  },
  { name: "awsKey", re: /AKIA[0-9A-Z]{16}/ },
  { name: "githubToken", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "privateKey", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "jwt", re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
  { name: "slackToken", re: /xox[abpr]-/ },
];

export const SECRET_PATTERN_NAMES: readonly string[] = SECRET_PATTERNS.map((p) => p.name);

/** Max bytes scanned per artifact; longer content is scanned as a prefix. */
const SCAN_LIMIT = 4 * 1024 * 1024;

const NoSecretsParams = z
  .object({
    disable: z.array(z.string()).default([]),
    allowPaths: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const contentNoSecrets = definePredicate<z.infer<typeof NoSecretsParams>>({
  id: "content.noSecrets",
  params: NoSecretsParams,
  requires: ["manifest", "content"],
  async run(ctx, { disable, allowPaths }) {
    const skip = globMatcher(allowPaths, false);
    const active = SECRET_PATTERNS.filter((p) => !disable.includes(p.name));
    const out: Finding[] = [];
    const decoder = new TextDecoder("utf-8", { fatal: false });
    for (const a of ctx.manifest.artifacts) {
      if (a.op === "delete" || skip(a.path)) continue;
      const bytes = await ctx.facts.content(a.path);
      if (bytes === undefined) continue;
      const text = decoder.decode(bytes.subarray(0, SCAN_LIMIT));
      for (const p of active) {
        if (!p.re.test(text)) continue;
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
