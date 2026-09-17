import { AxiomError, type Finding } from "@codai/axiom-schema";
import { BUILTIN_PREDICATES } from "./predicates/index.js";
import type { AnyPredicate, PredicateId } from "./types.js";

const ID_RE = /^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/;

export type ParamsResult = { ok: true; params: unknown } | { ok: false; finding: Finding };

export class PredicateRegistry {
  readonly #byId = new Map<string, AnyPredicate>();

  register(predicate: AnyPredicate): this {
    if (!ID_RE.test(predicate.id)) {
      throw new AxiomError("ERR_INTERNAL", `invalid predicate id: ${predicate.id}`);
    }
    if (this.#byId.has(predicate.id)) {
      throw new AxiomError("ERR_INTERNAL", `predicate already registered: ${predicate.id}`);
    }
    this.#byId.set(predicate.id, predicate);
    return this;
  }

  has(id: string): boolean {
    return this.#byId.has(id);
  }

  /** Throws ERR_PREDICATE_UNKNOWN. */
  get(id: string): AnyPredicate {
    const p = this.#byId.get(id);
    if (p === undefined) {
      throw new AxiomError("ERR_PREDICATE_UNKNOWN", `unknown predicate: ${id}`, {
        details: { predicate: id },
      });
    }
    return p;
  }

  list(): PredicateId[] {
    return [...this.#byId.keys()].sort() as PredicateId[];
  }

  /**
   * Validate params with the predicate's schema. Failure is returned as an
   * `error` finding (fail closed) rather than thrown, so the runner can record it.
   */
  validateParams(checkId: string, predicate: AnyPredicate, raw: unknown): ParamsResult {
    const r = predicate.params.safeParse(raw ?? {});
    if (r.success) return { ok: true, params: r.data };
    const issues = r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return {
      ok: false,
      finding: {
        id: checkId,
        severity: "error",
        predicate: predicate.id,
        message: `invalid params for ${predicate.id}: ${issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("; ")}`,
        facts: { code: "ERR_PREDICATE_PARAMS", issues, __provider: true },
      },
    };
  }
}

export function builtinRegistry(): PredicateRegistry {
  const r = new PredicateRegistry();
  for (const p of BUILTIN_PREDICATES) r.register(p);
  return r;
}
