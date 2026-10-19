import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createEmitterRegistry,
  type EmitterRegistry,
  type TemplateEmitter,
} from "@codai/axiom-plan";
import { AxiomError } from "@codai/axiom-schema";

/**
 * Template emitters (D-13: optional sugar) are NOT bundled into the CLI since 3.0 (D-45): a
 * `template` source works only when the user loads an emitter package with `--emitter <pkg>`.
 */
export const NO_EMITTERS: EmitterRegistry = createEmitterRegistry([]);
/** @deprecated 3.0 — no emitter is built in; use `loadEmitters()` / `NO_EMITTERS`. */
export const EMITTERS: EmitterRegistry = NO_EMITTERS;

export const EMITTER_HINT =
  "install @codai/axiom-emitters-web and pass --emitter @codai/axiom-emitters-web";

function isEmitterUnknown(err: unknown): err is AxiomError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ERR_EMITTER_UNKNOWN" &&
    (err as { details?: { reason?: unknown } }).details?.reason !== "duplicate"
  );
}

/** Re-throw an unknown-emitter failure with the install hint in `details.hint` and the message. */
export async function withEmitterHint<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (!isEmitterUnknown(err)) throw err;
    const e = err as AxiomError;
    const opts: NonNullable<ConstructorParameters<typeof AxiomError>[2]> = {
      details: { ...e.details, hint: EMITTER_HINT },
      cause: err,
    };
    if (e.path !== undefined) opts.path = e.path;
    throw new AxiomError("ERR_EMITTER_UNKNOWN", `${e.message} — ${EMITTER_HINT}`, opts);
  }
}

function isEmitter(v: unknown): v is TemplateEmitter {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Partial<TemplateEmitter>;
  return (
    typeof e.id === "string" &&
    typeof e.version === "string" &&
    typeof e.templates === "object" &&
    e.templates !== null
  );
}

/** Emitters a module offers: `emitters[]`, else an emitter-shaped default, else every named one. */
export function emittersOf(mod: Record<string, unknown>): TemplateEmitter[] {
  if (Array.isArray(mod.emitters)) return mod.emitters.filter(isEmitter);
  if (isEmitter(mod.default)) return [mod.default];
  return Object.values(mod).filter(isEmitter);
}

function entryOf(pkgDir: string): string {
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
    exports?: unknown;
    module?: string;
    main?: string;
  };
  const dot =
    typeof pkg.exports === "object" && pkg.exports !== null && "." in pkg.exports
      ? (pkg.exports as Record<string, unknown>)["."]
      : pkg.exports;
  const pick = (v: unknown): string | undefined => {
    if (typeof v === "string") return v;
    if (typeof v !== "object" || v === null) return undefined;
    const o = v as Record<string, unknown>;
    return pick(o.import) ?? pick(o.node) ?? pick(o.default);
  };
  return path.join(pkgDir, pick(dot) ?? pkg.module ?? pkg.main ?? "index.js");
}

/**
 * Resolve `spec` the way the root would: a path (absolute or `./…`, file or package dir) is
 * taken relative to `root`; a package name is looked up in `root`'s `node_modules` chain (ESM
 * `import` condition first — emitter packages are usually ESM-only), then via `createRequire`.
 */
export function resolveEmitterModule(spec: string, root: string): string {
  if (path.isAbsolute(spec) || spec.startsWith(".")) {
    const p = path.resolve(root, spec);
    if (existsSync(p) && statSync(p).isDirectory()) return entryOf(p);
    if (existsSync(p)) return p;
  } else {
    for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
      const pkgDir = path.join(dir, "node_modules", ...spec.split("/"));
      if (existsSync(path.join(pkgDir, "package.json"))) return entryOf(pkgDir);
      if (path.dirname(dir) === dir) break;
    }
    try {
      return createRequire(path.join(path.resolve(root), "package.json")).resolve(spec);
    } catch {
      // fall through to the structured error
    }
  }
  throw new AxiomError("ERR_EMITTER_UNKNOWN", `cannot resolve emitter package "${spec}"`, {
    details: { emitter: spec, root, reason: "not-installed", hint: EMITTER_HINT },
  });
}

/** `--emitter <pkg>` (repeatable) → registry. Empty list → `NO_EMITTERS`. */
export async function loadEmitters(
  specs: readonly string[],
  root: string,
): Promise<EmitterRegistry> {
  if (specs.length === 0) return NO_EMITTERS;
  const found: TemplateEmitter[] = [];
  for (const spec of specs) {
    const file = resolveEmitterModule(spec, root);
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const list = emittersOf(mod);
    if (list.length === 0) {
      throw new AxiomError("ERR_EMITTER_UNKNOWN", `"${spec}" exports no template emitter`, {
        details: { emitter: spec, reason: "no-emitter", hint: EMITTER_HINT },
      });
    }
    found.push(...list);
  }
  return createEmitterRegistry(found);
}

export interface EmitterRow {
  emitter: string;
  version: string;
  template: string;
  description: string;
}

/** Flat, sorted `emitter@version: template — description` rows for the CLI and the resource. */
export function emitterCatalogue(registry: EmitterRegistry = NO_EMITTERS): EmitterRow[] {
  const rows: EmitterRow[] = [];
  for (const id of registry.list()) {
    const e = registry.get(id);
    if (e === undefined) continue;
    for (const template of Object.keys(e.templates).sort()) {
      rows.push({
        emitter: e.id,
        version: e.version,
        template,
        description: e.templates[template]?.description ?? "",
      });
    }
  }
  return rows;
}
