import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { appliedPath } from "@codai/axiom-apply";
import {
  type ApplyResult,
  ApplyResultSchema,
  AxiomError,
  type CheckReport,
  CheckReportSchema,
  type DigestRef,
  DigestRefSchema,
  type ManifestBundle,
  ManifestBundleSchema,
} from "@codai/axiom-schema";

/** `<root>/.axiom/manifests/<hex>.json` and `<root>/.axiom/reports/<hex>.json`. */
export function manifestsDir(root: string): string {
  return path.join(root, ".axiom", "manifests");
}
export function reportsDir(root: string): string {
  return path.join(root, ".axiom", "reports");
}

export function hexOf(ref: DigestRef): string {
  return ref.slice("sha256:".length);
}

export function toDigestRef(shaOrRef: string): DigestRef {
  const ref = shaOrRef.startsWith("sha256:") ? shaOrRef : `sha256:${shaOrRef}`;
  const parsed = DigestRefSchema.safeParse(ref);
  if (!parsed.success) {
    throw new AxiomError("ERR_NOT_FOUND", `not a sha256 digest: ${shaOrRef}`);
  }
  return parsed.data;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(value), "utf8");
  await rename(tmp, file);
}

async function readJsonOrUndefined(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function saveManifest(root: string, bundle: ManifestBundle): Promise<string> {
  const file = path.join(manifestsDir(root), `${hexOf(bundle.manifestDigest)}.json`);
  await writeJsonAtomic(file, bundle);
  return file;
}

export async function saveReport(root: string, report: CheckReport): Promise<string> {
  const file = path.join(reportsDir(root), `${hexOf(report.manifestDigest)}.json`);
  await writeJsonAtomic(file, report);
  return file;
}

/** Search every root (allowlisted + seen) for a stored bundle. */
export async function loadManifest(
  roots: Iterable<string>,
  ref: DigestRef,
): Promise<ManifestBundle | undefined> {
  for (const root of roots) {
    const raw = await readJsonOrUndefined(path.join(manifestsDir(root), `${hexOf(ref)}.json`));
    if (raw !== undefined) return ManifestBundleSchema.parse(raw);
  }
  return undefined;
}

export async function loadReport(
  roots: Iterable<string>,
  ref: DigestRef,
): Promise<CheckReport | undefined> {
  for (const root of roots) {
    const raw = await readJsonOrUndefined(path.join(reportsDir(root), `${hexOf(ref)}.json`));
    if (raw !== undefined) return CheckReportSchema.parse(raw);
  }
  return undefined;
}

export async function loadApplied(
  roots: Iterable<string>,
  ref: DigestRef,
): Promise<ApplyResult | undefined> {
  for (const root of roots) {
    const raw = await readJsonOrUndefined(appliedPath(root, ref));
    if (raw !== undefined) return ApplyResultSchema.parse(raw);
  }
  return undefined;
}

export async function listStored(
  roots: Iterable<string>,
  sub: "manifests" | "reports" | "applied",
) {
  const out: { root: string; sha: string }[] = [];
  for (const root of roots) {
    let names: string[];
    try {
      names = await readdir(path.join(root, ".axiom", sub));
    } catch {
      continue;
    }
    for (const n of names) {
      const m = /^([0-9a-f]{64})\.json$/.exec(n);
      if (m?.[1] !== undefined) out.push({ root, sha: m[1] });
    }
  }
  return out;
}
