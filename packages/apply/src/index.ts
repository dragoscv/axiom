export type { ApplyOptions, RollbackOptions, StagedFile, StagedTree } from "./apply.js";
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
  worktreeDir,
} from "./apply.js";
export { CAS_BLOB_BYTES_MAX, casPath, resolveContent } from "./blobs.js";
export type { ResolvedTarget } from "./contain.js";
export {
  checkOnDiskCaseCollision,
  checkOnDiskPathCollision,
  checkReservedDir,
  checkTargetType,
  gitDirReal,
  isReservedAxiomPath,
  isReservedDirPath,
  probeCaseInsensitive,
  RESERVED_DIR,
  RESERVED_DIR_GIT,
  resolveContained,
  validateArtifactPaths,
} from "./contain.js";
export type { DiffEntry } from "./diff.js";
export { DIFF_CAP_BYTES, decodeText, diffOne, unifiedDiff } from "./diff.js";
export { fileDigestOrAbsent, isContained, sha256Of } from "./fsx.js";
export type { GitRunOptions, GitRunResult } from "./git.js";
export {
  addWorktree,
  buildCompareUrl,
  compareUrlFor,
  defaultBranchName,
  defaultCommitMessage,
  GIT_TIMEOUT_MS,
  materializeWorktreePaths,
  parseRemote,
  removeWorktree,
  runGit,
  scrubEnv,
  validateBranchName,
  validateBranchNameSyntax,
} from "./git.js";
export type {
  ChainEntry,
  ChainEntryInput,
  ChainFault,
  ChainState,
  ChainVerifyResult,
  HistoryEntry,
  HistoryFile,
  JournalStatus,
  JournalSummary,
  ListJournalsOptions,
} from "./journal.js";
export {
  appendChainEntry,
  assertChain,
  CHAIN_FILE,
  CHAIN_GENESIS,
  chainPath,
  finalizeJournal,
  journalDir,
  journalPath,
  journalStatus,
  listJournals,
  newJournal,
  parseJournal,
  pendingDir,
  pendingPath,
  readHistory,
  readJournal,
  recordTerminal,
  removeJournal,
  serializeChainEntry,
  setPhase,
  verifyChain,
  writeJournal,
} from "./journal.js";
export type { Intent, IntentRecord, Lock, LockHolder, LockStatus } from "./lock.js";
export {
  acquireLock,
  intentsDir,
  LOCK_HEARTBEAT_MS,
  LOCK_STALE_MS,
  LOCK_TIMEOUT_MS,
  liveHolderDigest,
  lockPath,
  lockStatus,
  overlappingPaths,
  queueDir,
  registerIntent,
  withLock,
} from "./lock.js";
export type { TreeMismatch, VerifyTreeOptions, VerifyTreeResult } from "./verify-tree.js";
export { verifyTree } from "./verify-tree.js";
export { RENAME_BACKOFF_MS, RENAME_RETRIES, renameRetry, writeAtomic } from "./write.js";
