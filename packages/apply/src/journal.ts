import fs from "node:fs/promises";
import * as path from "node:path";
import {
  AxiomError,
  type DigestRef,
  type Journal,
  type JournalPhase,
  JournalSchema,
  type JournalStep,
} from "@codai/axiom-schema";
import { errnoCode, fsyncDir, nsPath } from "./fsx.js";

export function journalDir(root: string): string {
  return path.join(root, ".axiom", "journal");
}

export function journalPath(root: string, digest: DigestRef): string {
  return path.join(journalDir(root), `${digest.slice("sha256:".length)}.json`);
}

export function newJournal(manifestDigest: DigestRef, steps: JournalStep[]): Journal {
  return {
    manifestDigest,
    phase: "staged",
    steps,
    startedAt: new Date().toISOString(),
    pid: process.pid,
  };
}

/** Write the journal atomically (tmp → fsync → rename) and fsync the directory. */
export async function writeJournal(root: string, journal: Journal): Promise<string> {
  const dir = journalDir(root);
  await fs.mkdir(dir, { recursive: true });
  const target = journalPath(root, journal.manifestDigest);
  const tmp = `${target}.tmp-${process.pid}`;
  const fh = await fs.open(nsPath(tmp), "w");
  try {
    await fh.writeFile(JSON.stringify(journal), "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(nsPath(tmp), nsPath(target));
  await fsyncDir(dir);
  return target;
}

export async function readJournal(root: string, digest: DigestRef): Promise<Journal | undefined> {
  const p = journalPath(root, digest);
  let raw: string;
  try {
    raw = await fs.readFile(nsPath(p), "utf8");
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return undefined;
    throw err;
  }
  return parseJournal(raw, p);
}

export function parseJournal(raw: string, p: string): Journal {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new AxiomError("ERR_JOURNAL_CORRUPT", "journal is not valid JSON", {
      cause: err,
      details: { file: p },
    });
  }
  const r = JournalSchema.safeParse(json);
  if (!r.success) {
    throw new AxiomError("ERR_JOURNAL_CORRUPT", "journal does not match schema", {
      details: { file: p, issues: r.error.issues.map((i) => i.message) },
    });
  }
  return r.data;
}

/** All journals under `.axiom/journal/` (corrupt ones are reported, not thrown). */
export async function listJournals(
  root: string,
): Promise<{ journals: Journal[]; corrupt: string[] }> {
  const dir = journalDir(root);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return { journals: [], corrupt: [] };
    throw err;
  }
  const journals: Journal[] = [];
  const corrupt: string[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const p = path.join(dir, n);
    try {
      journals.push(parseJournal(await fs.readFile(p, "utf8"), p));
    } catch {
      corrupt.push(p);
    }
  }
  return { journals, corrupt };
}

export async function setPhase(
  root: string,
  journal: Journal,
  phase: JournalPhase,
): Promise<Journal> {
  const next: Journal = { ...journal, phase };
  await writeJournal(root, next);
  return next;
}

export async function removeJournal(root: string, digest: DigestRef): Promise<void> {
  await fs.rm(journalPath(root, digest), { force: true });
}
