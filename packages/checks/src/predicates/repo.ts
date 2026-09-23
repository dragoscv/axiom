import type { Finding } from "@codai/axiom-schema";
import { z } from "zod";
import { definePredicate, type FactContext } from "../types.js";
import { finding, globMatcher } from "./util.js";

const NoOverwriteParams = z.object({ globs: z.array(z.string().min(1)).min(1) }).strict();

/** Fails when an overwrite/delete targets a protected path that exists in the repo. */
export const repoNoOverwriteOf = definePredicate<z.infer<typeof NoOverwriteParams>>({
  id: "repo.noOverwriteOf",
  params: NoOverwriteParams,
  requires: ["manifest", "repo"],
  async run(ctx, { globs }) {
    const repo = ctx.facts.repo;
    if (repo === undefined) return [];
    const protectedPath = globMatcher(globs, false);
    const out: Finding[] = [];
    for (const a of ctx.manifest.artifacts) {
      if (a.op === "create" || !protectedPath(a.path)) continue;
      if (!(await repo.exists(a.path))) continue;
      out.push(
        finding({
          id: "repo.noOverwriteOf",
          predicate: "repo.noOverwriteOf",
          path: a.path,
          message: `${a.op} of protected existing file`,
          facts: { op: a.op, globs },
        }),
      );
    }
    return out;
  },
});

const CompanionParams = z
  .object({
    rules: z
      .array(
        z
          .object({
            when: z.string().min(1),
            expect: z
              .array(
                z
                  .object({
                    name: z.string().min(1),
                    match: z.string().min(1),
                    /**
                     * S-408 (A15): the companion must be *in this plan*, not merely exist in
                     * the repo. Use for "if you touch the schema you must touch the migration"
                     * rules, where a stale existing file is exactly the bug being guarded.
                     */
                    mustChange: z.boolean().default(false),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/**
 * brivio `check-ripple` shape: when any artifact matches `when`, every `expect`
 * must be satisfied by at least one artifact path OR (unless `mustChange`) one
 * existing repo file.
 */
export const repoRequireCompanion = definePredicate<z.infer<typeof CompanionParams>>({
  id: "repo.requireCompanion",
  params: CompanionParams,
  requires: ["manifest", "repo"],
  async run(ctx, { rules }) {
    const paths = ctx.facts.manifest.paths;
    const out: Finding[] = [];
    for (const rule of rules) {
      const when = globMatcher([rule.when], false);
      const triggers = paths.filter(when);
      if (triggers.length === 0) continue;
      for (const exp of rule.expect) {
        const match = globMatcher([exp.match], false);
        if (paths.some(match)) continue;
        if (!exp.mustChange) {
          const inRepo = ctx.facts.repo ? await ctx.facts.repo.glob(exp.match) : [];
          if (inRepo.length > 0) continue;
        }
        out.push(
          finding({
            id: `repo.requireCompanion.${exp.name}`,
            predicate: "repo.requireCompanion",
            message: exp.mustChange
              ? `"${rule.when}" changed but the plan does not also change "${exp.match}" (${exp.name})`
              : `"${rule.when}" changed but no companion matches "${exp.match}" (${exp.name})`,
            facts: {
              when: rule.when,
              expect: exp.match,
              name: exp.name,
              mustChange: exp.mustChange,
              triggers,
            },
          }),
        );
      }
    }
    return out;
  },
});

const REFERENCE_READ_MAX = 8 * 1024 * 1024;
const REFERENCE_PREDICATE = "repo.requireReference" as const;

const ReferenceRuleSchema = z
  .object({
    name: z.string().min(1),
    /** Glob over plan artifact paths; every match triggers the rule. */
    when: z.string().min(1),
    /** The companion file, as a repo-relative path (not a glob). */
    in: z.string().min(1),
    /**
     * Template rendered per triggering artifact: `${path}` (its full relative path),
     * `${basename}` (last segment), `${dirname}` (everything before it, "" at root).
     */
    mustContain: z.string().min(1),
    /** The companion must be *in this plan*; an existing repo file does not count. */
    mustChange: z.boolean().default(false),
    /**
     * When set, `in` is parsed as JSON and the pointer (RFC 6901) is resolved; the
     * value there — a string, an array of strings, or an object (its keys) — must
     * contain the rendered template. Without it, plain substring over the bytes.
     */
    jsonPointer: z
      .string()
      .regex(/^(\/|$)/, "jsonPointer must be empty or start with /")
      .optional(),
  })
  .strict();

const ReferenceParams = z.object({ rules: z.array(ReferenceRuleSchema).min(1) }).strict();

export type ReferenceRule = z.infer<typeof ReferenceRuleSchema>;

/** Render `${path}` / `${basename}` / `${dirname}` for one artifact path; unknown keys are left as-is. */
export function renderReferenceTemplate(template: string, artifactPath: string): string {
  const slash = artifactPath.lastIndexOf("/");
  const vars: Record<string, string> = {
    path: artifactPath,
    basename: slash === -1 ? artifactPath : artifactPath.slice(slash + 1),
    dirname: slash === -1 ? "" : artifactPath.slice(0, slash),
  };
  return template.replace(/\$\{(path|basename|dirname)\}/g, (_m, k: string) => vars[k] ?? _m);
}

/** RFC 6901 resolution; `undefined` when any step is missing. */
export function resolveJsonPointer(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
      cur = cur[Number(key)];
    } else if (typeof cur === "object" && cur !== null) {
      if (!Object.hasOwn(cur, key)) return undefined;
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Does the pointed-at value "contain" `expected`? string → substring; string[] → member; object → key. */
function pointerValueContains(value: unknown, expected: string): boolean | undefined {
  if (typeof value === "string") return value.includes(expected);
  if (Array.isArray(value)) return value.some((v) => typeof v === "string" && v === expected);
  if (typeof value === "object" && value !== null) return Object.hasOwn(value, expected);
  return undefined;
}

type ReferenceSource = "plan" | "repo" | "absent";

/** Locate the companion's bytes: plan blob first, then the repo (unless `mustChange`). */
async function readCompanion(
  ctx: FactContext,
  rule: ReferenceRule,
): Promise<{ source: ReferenceSource; bytes: Uint8Array | undefined; unreadable: boolean }> {
  const inPlan = ctx.manifest.artifacts.find((a) => a.path === rule.in);
  if (inPlan !== undefined) {
    // The plan deletes the companion: after apply it will not exist, whatever the repo holds now.
    if (inPlan.op === "delete") return { source: "absent", bytes: undefined, unreadable: false };
    const bytes = await ctx.facts.content(rule.in);
    // Blob unavailable → not a rule violation; the runner already reports missing facts.
    return { source: "plan", bytes, unreadable: false };
  }
  if (rule.mustChange) return { source: "absent", bytes: undefined, unreadable: false };
  const repo = ctx.facts.repo;
  if (repo === undefined || !(await repo.exists(rule.in))) {
    return { source: "absent", bytes: undefined, unreadable: false };
  }
  const bytes = await repo.read(rule.in, REFERENCE_READ_MAX);
  // exists() said yes but read() could not deliver (directory, permissions, race) → fail closed.
  return { source: "repo", bytes, unreadable: bytes === undefined };
}

function referenceFinding(
  rule: ReferenceRule,
  path: string,
  expected: string,
  source: ReferenceSource,
  message: string,
  extra: Record<string, unknown> = {},
): Finding {
  return finding({
    id: `${REFERENCE_PREDICATE}.${rule.name}`,
    predicate: REFERENCE_PREDICATE,
    path,
    message,
    facts: { in: rule.in, expected, source, ...extra },
  });
}

/**
 * Content-level ripple: when an artifact matches `when`, the companion `in` must
 * mention it. Extends `repo.requireCompanion` (which only asks "does a companion
 * path exist") to "does the companion *reference this artifact*" — the shape of
 * brivio's `check-sdk-coverage` / route-registry guards, and of any "new tool ⇒
 * listed in tools.json", "new page ⇒ listed in the sitemap", "new package ⇒ in
 * the workspace globs" rule. Fails closed (`error` finding, `__provider`) when the
 * companion exists but cannot be read, or when `jsonPointer` is set and the
 * companion is not valid JSON or the pointer resolves to something that cannot
 * contain a string.
 */
export const repoRequireReference = definePredicate<z.infer<typeof ReferenceParams>>({
  id: REFERENCE_PREDICATE,
  params: ReferenceParams,
  requires: ["manifest", "content", "repo"],
  async run(ctx, { rules }) {
    const out: Finding[] = [];
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const rule of rules) {
      const when = globMatcher([rule.when], false);
      const triggers = ctx.manifest.artifacts
        .filter((a) => a.op !== "delete" && a.path !== rule.in && when(a.path))
        .map((a) => a.path);
      if (triggers.length === 0) continue;

      const companion = await readCompanion(ctx, rule);
      if (companion.source === "plan" && companion.bytes === undefined) continue;

      // Decode/parse once per rule; every trigger shares the verdict on the companion itself.
      let text: string | undefined;
      let json: unknown;
      let companionError: { code: string; message: string } | undefined;
      if (companion.unreadable) {
        companionError = {
          code: "ERR_PROVIDER_FAILED",
          message: `companion "${rule.in}" exists in the repo but could not be read`,
        };
      } else if (companion.bytes !== undefined) {
        try {
          text = decoder.decode(companion.bytes);
        } catch {
          companionError = {
            code: "ERR_PROVIDER_FAILED",
            message: `companion "${rule.in}" is not valid UTF-8`,
          };
        }
        if (text !== undefined && rule.jsonPointer !== undefined) {
          try {
            json = JSON.parse(text);
          } catch {
            companionError = {
              code: "ERR_PROVIDER_FAILED",
              message: `companion "${rule.in}" is not valid JSON (jsonPointer set)`,
            };
          }
        }
      }

      for (const path of triggers) {
        const expected = renderReferenceTemplate(rule.mustContain, path);
        if (companionError !== undefined) {
          out.push(
            referenceFinding(rule, path, expected, companion.source, companionError.message, {
              code: companionError.code,
              __provider: true,
            }),
          );
          continue;
        }
        if (companion.source === "absent" || text === undefined) {
          out.push(
            referenceFinding(
              rule,
              path,
              expected,
              "absent",
              rule.mustChange
                ? `"${path}" changed but the plan does not also change "${rule.in}" (${rule.name})`
                : `"${path}" changed but "${rule.in}" is neither in the plan nor in the repo (${rule.name})`,
              { mustChange: rule.mustChange },
            ),
          );
          continue;
        }
        if (rule.jsonPointer === undefined) {
          if (text.includes(expected)) continue;
          out.push(
            referenceFinding(
              rule,
              path,
              expected,
              companion.source,
              `"${rule.in}" does not mention "${expected}" (${rule.name})`,
            ),
          );
          continue;
        }
        const value = resolveJsonPointer(json, rule.jsonPointer);
        const contains = pointerValueContains(value, expected);
        if (contains === undefined) {
          out.push(
            referenceFinding(
              rule,
              path,
              expected,
              companion.source,
              value === undefined
                ? `"${rule.in}": jsonPointer "${rule.jsonPointer}" does not resolve`
                : `"${rule.in}": jsonPointer "${rule.jsonPointer}" is a ${typeof value}, not a string, array or object`,
              { code: "ERR_PROVIDER_FAILED", __provider: true, jsonPointer: rule.jsonPointer },
            ),
          );
          continue;
        }
        if (contains) continue;
        out.push(
          referenceFinding(
            rule,
            path,
            expected,
            companion.source,
            `"${rule.in}" at "${rule.jsonPointer}" does not contain "${expected}" (${rule.name})`,
            { jsonPointer: rule.jsonPointer },
          ),
        );
      }
    }
    return out;
  },
});
