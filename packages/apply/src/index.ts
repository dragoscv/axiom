export type { ApplyOptions, StagedFile, StagedTree } from "./apply.js";
export {
  appliedPath,
  apply,
  axiomDir,
  backupDir,
  DEFAULT_KEEP_BACKUPS,
  JOURNAL_FSYNC_EVERY,
  recoverIfNeeded,
  rollback,
  stagingDir,
} from "./apply.js";
export { CAS_BLOB_BYTES_MAX, casPath, resolveContent } from "./blobs.js";
export type { ResolvedTarget } from "./contain.js";
export {
  checkOnDiskCaseCollision,
  checkTargetType,
  probeCaseInsensitive,
  resolveContained,
  validateArtifactPaths,
} from "./contain.js";
export type { DiffEntry } from "./diff.js";
export { DIFF_CAP_BYTES, decodeText, diffOne, unifiedDiff } from "./diff.js";
export { fileDigestOrAbsent, isContained, sha256Of } from "./fsx.js";
export {
  journalDir,
  journalPath,
  listJournals,
  newJournal,
  parseJournal,
  readJournal,
  removeJournal,
  setPhase,
  writeJournal,
} from "./journal.js";
export type { Lock, LockHolder } from "./lock.js";
export { acquireLock, LOCK_STALE_MS, LOCK_TIMEOUT_MS, lockPath, withLock } from "./lock.js";
export { RENAME_BACKOFF_MS, RENAME_RETRIES, renameRetry, writeAtomic } from "./write.js";
