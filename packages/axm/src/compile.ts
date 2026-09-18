/**
 * CST → `Plan`. Walks the concrete syntax tree produced by `AxmParser`, builds a
 * `PlanInput`, validates it with `PlanSchema` and maps every Zod issue back to the
 * source range of the offending item through a position map keyed by JSON path.
 */
import {
  type ErrorCode,
  isErrorCode,
  type Plan,
  type PlanArtifactSource,
  type PlanInput,
  PlanSchema,
} from "@codai/axiom-schema";
import type { CstElement, CstNode, IToken } from "chevrotain";
import { type Diagnostic, ORIGIN, type Range, spanRange, tokenRange } from "./diagnostics.js";
import { CapKw, type HereDocPayload } from "./lexer.js";

export const AXM_VERSION = "2";

export interface CompileResult {
  plan?: Plan;
  diagnostics: Diagnostic[];
}

type Children = Record<string, CstElement[] | undefined>;

function isToken(e: CstElement): e is IToken {
  return (e as IToken).image !== undefined;
}
function tokens(ctx: Children, key: string): IToken[] {
  return (ctx[key] ?? []).filter(isToken);
}
function nodes(ctx: Children, key: string): CstNode[] {
  return (ctx[key] ?? []).filter((e): e is CstNode => !isToken(e));
}
function first<T>(xs: readonly T[]): T | undefined {
  return xs[0];
}
function hasCategory(t: IToken, cat: { name: string }): boolean {
  return (t.tokenType.CATEGORIES ?? []).some((c) => c.name === cat.name);
}
/** Whole extent of a CST node, from its first to its last token. */
function nodeRange(n: CstNode): Range {
  const loc = n.location;
  if (loc === undefined || loc.startLine === undefined) return ORIGIN;
  return {
    start: { line: loc.startLine, column: loc.startColumn ?? 1 },
    end: {
      line: loc.endLine ?? loc.startLine,
      column: (loc.endColumn ?? loc.startColumn ?? 1) + 1,
    },
  };
}

/** Decode a `StringLit`/`Digest` image (JSON string syntax). */
export function decodeString(image: string): string {
  return JSON.parse(image) as string;
}

class Compiler {
  readonly diagnostics: Diagnostic[] = [];
  /** JSON path (dot-joined) → source range, for mapping schema issues back to text. */
  readonly positions = new Map<string, Range>();

  error(message: string, range: Range, code: ErrorCode = "ERR_INVALID_PLAN"): void {
    this.diagnostics.push({ severity: "error", message, code, range });
  }

  at(path: string, range: Range): void {
    this.positions.set(path, range);
  }

  compile(file: CstNode): PlanInput | undefined {
    const ctx = file.children as Children;
    const header = first(nodes(ctx, "header"));
    if (header !== undefined) this.header(header);
    const plans = nodes(ctx, "planDecl");
    const decl = first(plans);
    if (decl === undefined) {
      this.error("file declares no plan", header === undefined ? ORIGIN : nodeRange(header));
      return undefined;
    }
    for (const extra of plans.slice(1)) {
      this.error("only one plan per file is allowed", nodeRange(extra));
    }
    return this.planDecl(decl);
  }

  header(n: CstNode): void {
    const v = first(tokens(n.children as Children, "version"));
    if (v === undefined) return;
    let version: string | undefined;
    try {
      version = decodeString(v.image);
    } catch {
      version = undefined;
    }
    if (version !== AXM_VERSION) {
      this.error(`unsupported axm version ${v.image}; expected "${AXM_VERSION}"`, tokenRange(v));
    }
  }

  planDecl(n: CstNode): PlanInput {
    const ctx = n.children as Children;
    const nameTok = first(tokens(ctx, "name"));
    this.at("name", tokenRange(nameTok));
    const plan: PlanInput = {
      apiVersion: "axiom.dev/v2",
      kind: "Plan",
      name: nameTok?.image ?? "",
      intent: "",
      artifacts: [],
    };
    const seen = new Set<string>();
    const once = (key: string, range: Range): boolean => {
      if (seen.has(key)) {
        this.error(`duplicate ${key}`, range);
        return false;
      }
      seen.add(key);
      return true;
    };
    const artifacts: NonNullable<PlanInput["artifacts"]> = [];
    const checks: NonNullable<PlanInput["checks"]> = [];
    const artifactPaths = new Map<string, Range>();
    let intentSeen = false;

    for (const item of nodes(ctx, "planItem")) {
      const ic = item.children as Children;
      const intent = first(nodes(ic, "intentItem"));
      const profile = first(nodes(ic, "profileItem"));
      const caps = first(nodes(ic, "capabilitiesItem"));
      const artifact = first(nodes(ic, "artifactItem"));
      const check = first(nodes(ic, "checkItem"));
      const meta = first(nodes(ic, "metaItem"));

      if (intent !== undefined) {
        const r = nodeRange(intent);
        if (once("intent", r)) {
          intentSeen = true;
          const v = first(tokens(intent.children as Children, "value"));
          plan.intent = v === undefined ? "" : decodeString(v.image);
          this.at("intent", tokenRange(v));
        }
      } else if (profile !== undefined) {
        const r = nodeRange(profile);
        if (once("profile", r)) {
          const v = first(tokens(profile.children as Children, "value"));
          plan.profile = v?.image ?? "default";
          this.at("profile", tokenRange(v));
        }
      } else if (caps !== undefined) {
        const r = nodeRange(caps);
        if (once("capabilities", r)) plan.capabilities = this.capabilities(caps);
      } else if (artifact !== undefined) {
        const idx = artifacts.length;
        const a = this.artifact(artifact, `artifacts.${idx}`);
        const pathTok = first(tokens(artifact.children as Children, "path"));
        const prev = artifactPaths.get(a.path);
        if (prev !== undefined) {
          this.error(`duplicate artifact path "${a.path}"`, tokenRange(pathTok));
        } else {
          artifactPaths.set(a.path, tokenRange(pathTok));
        }
        artifacts.push(a);
      } else if (check !== undefined) {
        checks.push(this.check(check, `checks.${checks.length}`));
      } else if (meta !== undefined) {
        const r = nodeRange(meta);
        if (once("meta", r)) {
          const v = first(tokens(meta.children as Children, "value"));
          const parsed = this.json(v, "meta");
          this.at("metadata", tokenRange(v));
          if (parsed !== undefined) {
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              plan.metadata = parsed as Record<string, never>;
            } else {
              this.error("meta must be a JSON object", tokenRange(v));
            }
          }
        }
      }
    }
    if (!intentSeen) this.error("plan has no intent", tokenRange(nameTok));
    plan.artifacts = artifacts;
    if (checks.length > 0) plan.checks = checks;
    this.at("artifacts", nodeRange(n));
    return plan;
  }

  capabilities(n: CstNode): NonNullable<PlanInput["capabilities"]> {
    const out: string[] = [];
    const seen = new Set<string>();
    tokens(n.children as Children, "cap").forEach((t, i) => {
      this.at(`capabilities.${i}`, tokenRange(t));
      if (!hasCategory(t, CapKw)) {
        this.error(
          `unknown capability "${t.image}" (expected fs, net, secret, ai, compute or git)`,
          tokenRange(t),
        );
        return;
      }
      if (seen.has(t.image)) {
        this.error(`duplicate capability "${t.image}"`, tokenRange(t));
        return;
      }
      seen.add(t.image);
      out.push(t.image);
    });
    return out as NonNullable<PlanInput["capabilities"]>;
  }

  artifact(n: CstNode, path: string): NonNullable<PlanInput["artifacts"]>[number] {
    const ctx = n.children as Children;
    const pathTok = first(tokens(ctx, "path"));
    this.at(path, nodeRange(n));
    this.at(`${path}.path`, tokenRange(pathTok));
    const a: NonNullable<PlanInput["artifacts"]>[number] = {
      path: pathTok === undefined ? "" : decodeString(pathTok.image),
    };
    const body = first(nodes(ctx, "artifactBody"));
    if (body === undefined) return a;
    const bc = body.children as Children;
    for (const m of nodes(bc, "modeField")) {
      const v = first(tokens(m.children as Children, "value"));
      if (a.mode !== undefined) this.error("duplicate mode", nodeRange(m));
      if (v !== undefined && v.image !== "0644" && v.image !== "0755") {
        this.error(`mode must be 0644 or 0755, got ${v.image}`, tokenRange(v));
      }
      a.mode = v?.image as typeof a.mode;
      this.at(`${path}.mode`, tokenRange(v));
    }
    for (const o of nodes(bc, "opField")) {
      const v = first(tokens(o.children as Children, "value"));
      if (a.op !== undefined) this.error("duplicate op", nodeRange(o));
      a.op = v?.image as typeof a.op;
      this.at(`${path}.op`, tokenRange(v));
    }
    const sources = nodes(bc, "source");
    for (const s of sources.slice(1))
      this.error("an artifact has exactly one source", nodeRange(s));
    const src = first(sources);
    if (src !== undefined) {
      this.at(`${path}.source`, nodeRange(src));
      a.source = this.source(src, `${path}.source`);
    } else {
      // a missing source is reported by the schema (unless op is delete) — point at the body
      this.at(`${path}.source`, nodeRange(body));
    }
    return a;
  }

  source(n: CstNode, path: string): PlanArtifactSource | undefined {
    const ctx = n.children as Children;
    const inline = first(nodes(ctx, "inlineSource"));
    if (inline !== undefined) {
      const h = first(tokens(inline.children as Children, "content"));
      const payload = h?.payload as HereDocPayload | undefined;
      this.at(`${path}.content`, tokenRange(h));
      return { type: "inline", encoding: "utf8", content: payload?.content ?? "" };
    }
    const cas = first(nodes(ctx, "casSource"));
    if (cas !== undefined) {
      const d = first(tokens(cas.children as Children, "digest"));
      this.at(`${path}.digest`, tokenRange(d));
      return { type: "cas", digest: decodeString(d?.image ?? '""') as `sha256:${string}` };
    }
    const ref = first(nodes(ctx, "refSource"));
    if (ref !== undefined) {
      const rc = ref.children as Children;
      const u = first(tokens(rc, "uri"));
      const d = first(tokens(rc, "digest"));
      this.at(`${path}.uri`, tokenRange(u));
      this.at(`${path}.digest`, tokenRange(d));
      return {
        type: "ref",
        uri: decodeString(u?.image ?? '""'),
        digest: decodeString(d?.image ?? '""') as `sha256:${string}`,
      };
    }
    const tpl = first(nodes(ctx, "templateSource"));
    if (tpl !== undefined) {
      const tc = tpl.children as Children;
      const emitter = this.qualIdent(first(nodes(tc, "emitter")));
      const t = first(tokens(tc, "template"));
      const p = first(tokens(tc, "params"));
      this.at(`${path}.emitter`, nodeRange(first(nodes(tc, "emitter")) ?? tpl));
      this.at(`${path}.template`, tokenRange(t));
      this.at(`${path}.params`, tokenRange(p ?? t));
      const params = p === undefined ? {} : this.json(p, "template params");
      const out: PlanArtifactSource = {
        type: "template",
        emitter,
        template: t === undefined ? "" : decodeString(t.image),
        params: (params ?? {}) as Record<string, never>,
      };
      return out;
    }
    return undefined;
  }

  check(n: CstNode, path: string): NonNullable<PlanInput["checks"]>[number] {
    const ctx = n.children as Children;
    const id = first(tokens(ctx, "id"));
    const pred = first(nodes(ctx, "predicate"));
    const p = first(tokens(ctx, "params"));
    this.at(path, nodeRange(n));
    this.at(`${path}.id`, tokenRange(id));
    this.at(`${path}.predicate`, pred === undefined ? tokenRange(id) : nodeRange(pred));
    this.at(`${path}.params`, tokenRange(p ?? id));
    const params = p === undefined ? {} : this.json(p, "check params");
    return {
      id: id?.image ?? "",
      predicate: this.qualIdent(pred),
      params: (params ?? {}) as never,
      severity: "error",
    };
  }

  qualIdent(n: CstNode | undefined): string {
    if (n === undefined) return "";
    return tokens(n.children as Children, "part")
      .map((t) => t.image)
      .join(".");
  }

  json(t: IToken | undefined, what: string): unknown {
    if (t === undefined) return undefined;
    try {
      return JSON.parse(t.image) as unknown;
    } catch (e) {
      this.error(`${what}: ${e instanceof Error ? e.message : "invalid JSON"}`, tokenRange(t));
      return undefined;
    }
  }

  /** Longest-prefix lookup of a Zod issue path in the position map. */
  rangeFor(path: readonly PropertyKey[]): Range {
    const parts = path.map(String);
    for (let i = parts.length; i > 0; i--) {
      const r = this.positions.get(parts.slice(0, i).join("."));
      if (r !== undefined) return r;
    }
    return this.positions.get("name") ?? ORIGIN;
  }

  validate(input: PlanInput): Plan | undefined {
    const parsed = PlanSchema.safeParse(input);
    if (parsed.success) return parsed.data;
    for (const issue of parsed.error.issues) {
      const raw = (issue as { params?: { code?: unknown } }).params?.code;
      const code: ErrorCode = isErrorCode(raw) ? raw : "ERR_INVALID_PLAN";
      const where = issue.path.map(String).join(".");
      this.error(
        where === "" ? issue.message : `${where}: ${issue.message}`,
        this.rangeFor(issue.path),
        code,
      );
    }
    return undefined;
  }
}

/** Compile a parsed CST. Diagnostics from lexing/parsing are appended by the caller. */
export function compileCst(file: CstNode | undefined): CompileResult {
  const c = new Compiler();
  if (file === undefined) return { diagnostics: c.diagnostics };
  const input = c.compile(file);
  if (input === undefined || c.diagnostics.length > 0) return { diagnostics: c.diagnostics };
  const plan = c.validate(input);
  return plan === undefined ? { diagnostics: c.diagnostics } : { plan, diagnostics: c.diagnostics };
}

export { spanRange };
