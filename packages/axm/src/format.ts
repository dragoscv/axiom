/**
 * `Plan` → `.axm` text. Deterministic: field order fixed, 2-space indent, LF line
 * endings, JSON via `JSON.stringify` (no whitespace). Defaults are always written out
 * so that `parseAxm(formatAxm(p)).plan` deep-equals `p` for any valid `Plan`.
 */
import type { Plan, PlanArtifact } from "@codai/axiom-schema";

const IDENT = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

function str(s: string): string {
  return JSON.stringify(s);
}

/** `EOF`, or `EOF_1`, `EOF_2`, … when a line of the content would equal the terminator. */
export function hereDocTerminator(content: string): string {
  const lines = new Set(content.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)));
  if (!lines.has("EOF")) return "EOF";
  for (let n = 1; ; n++) {
    const t = `EOF_${n}`;
    if (!lines.has(t)) return t;
  }
}

function hereDoc(content: string): string {
  const t = hereDocTerminator(content);
  // Content and terminator are emitted at column 1 so bytes survive the roundtrip.
  return content.length === 0 ? `<<${t}\n${t}` : `<<${t}\n${content}\n${t}`;
}

function source(a: PlanArtifact, indent: string): string | undefined {
  const s = a.source;
  if (s === undefined) return undefined;
  switch (s.type) {
    case "inline": {
      if (s.encoding !== "utf8") {
        throw new TypeError("formatAxm: only utf8 inline sources have an .axm form");
      }
      return `${indent}inline ${hereDoc(s.content)}`;
    }
    case "cas":
      return `${indent}cas ${str(s.digest)}`;
    case "ref":
      return `${indent}ref ${str(s.uri)} ${str(s.digest)}`;
    case "template": {
      if (!s.emitter.split(".").every((p) => IDENT.test(p))) {
        throw new TypeError(`formatAxm: template emitter "${s.emitter}" is not a QualIdent`);
      }
      return `${indent}template ${s.emitter} ${str(s.template)} ${JSON.stringify(s.params)}`;
    }
  }
}

export function formatAxm(plan: Plan): string {
  if (!IDENT.test(plan.name)) {
    throw new TypeError(`formatAxm: plan name "${plan.name}" is not an Ident`);
  }
  if (!IDENT.test(plan.profile)) {
    throw new TypeError(`formatAxm: profile "${plan.profile}" is not an Ident`);
  }
  const out: string[] = ['axiom "2"', "", `plan ${plan.name} {`];
  out.push(`  intent ${str(plan.intent)}`);
  out.push(`  profile ${plan.profile}`);
  out.push(`  capabilities [${plan.capabilities.join(", ")}]`);
  for (const a of plan.artifacts) {
    out.push("", `  artifact ${str(a.path)} {`);
    out.push(`    mode ${a.mode}`);
    out.push(`    op ${a.op}`);
    const s = source(a, "    ");
    if (s !== undefined) out.push(s);
    out.push("  }");
  }
  if (plan.checks.length > 0) out.push("");
  for (const c of plan.checks) {
    if (!IDENT.test(c.id)) throw new TypeError(`formatAxm: check id "${c.id}" is not an Ident`);
    if (c.severity !== "error") {
      throw new TypeError("formatAxm: .axm checks are always severity error");
    }
    const params = JSON.stringify(c.params);
    const isBlock = params.startsWith("{") || params.startsWith("[");
    if (!isBlock) {
      throw new TypeError("formatAxm: check params must be a JSON object or array");
    }
    out.push(`  check ${c.id} using ${c.predicate} ${params}`);
  }
  out.push("", `  meta ${JSON.stringify(plan.metadata)}`, "}", "");
  return out.join("\n");
}
