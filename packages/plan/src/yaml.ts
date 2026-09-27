import { AxiomError } from "@codai/axiom-schema";

/**
 * YAML front-end for Plans (S-707). The result is a plain object meant for
 * `compilePlan` / `PlanSchema`; it is NOT validated here.
 *
 * Hardening:
 * - `yaml` is loaded lazily (`import("yaml")`) so it never lands in an eager bundle.
 * - YAML 1.2 `core` schema only: no `!!binary`/`!!set`/custom tags, no `<<` merge keys.
 *   Any unresolved tag or other parser warning is an error, not a silent string.
 * - At most `maxAliasCount` (100) alias expansions — alias bombs are rejected.
 * - Duplicate mapping keys are rejected.
 * - Exactly one document; the root must be a mapping.
 *
 * `$schema` handling: a leading `# yaml-language-server: $schema=…` line is a
 * plain comment and is ignored by the parser. A top-level `$schema` KEY (editor
 * hint, JSON-Schema style) is stripped before the object is returned, because
 * `PlanSchema` is strict and would otherwise reject it.
 */
export const YAML_MAX_ALIAS_COUNT = 100;

/** True for `.yaml` / `.yml` paths (case-insensitive). */
export function isYamlPath(p: string): boolean {
  return /\.ya?ml$/i.test(p);
}

interface LinePos {
  line: number;
  col: number;
}

function invalid(message: string, pos?: LinePos, cause?: unknown): AxiomError {
  const details: Record<string, unknown> = { format: "yaml" };
  if (pos) {
    details.line = pos.line;
    details.column = pos.col;
  }
  return new AxiomError(
    "ERR_INVALID_PLAN",
    message,
    cause === undefined ? { details } : { details, cause },
  );
}

/** Parse a single YAML document into a plain Plan-shaped object. */
export async function parsePlanYaml(text: string): Promise<unknown> {
  const { parseAllDocuments, isMap } = await import("yaml");
  const docs = parseAllDocuments(text, {
    schema: "core",
    merge: false,
    resolveKnownTags: false,
    uniqueKeys: true,
    prettyErrors: true,
    strict: true,
  });
  if (docs.length === 0) throw invalid("YAML plan is empty");
  if (docs.length > 1) {
    const second = docs[1]?.range?.[0];
    const pos = second === undefined ? undefined : linePosAt(text, second);
    throw invalid(`YAML plan must contain exactly one document, got ${docs.length}`, pos);
  }
  const doc = docs[0];
  if (doc === undefined) throw invalid("YAML plan is empty");
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem)
    throw invalid(`YAML ${problem.code}: ${problem.message}`, problem.linePos?.[0], problem);
  if (!isMap(doc.contents)) {
    const start = doc.contents?.range?.[0];
    throw invalid(
      "YAML plan root must be a mapping",
      start === undefined ? undefined : linePosAt(text, start),
    );
  }
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: YAML_MAX_ALIAS_COUNT });
  } catch (err) {
    throw invalid(`YAML plan rejected: ${(err as Error).message}`, undefined, err);
  }
  const { $schema: _editorHint, ...plan } = value as Record<string, unknown>;
  return plan;
}

function linePosAt(text: string, offset: number): LinePos {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      col = 1;
    } else col++;
  }
  return { line, col };
}
