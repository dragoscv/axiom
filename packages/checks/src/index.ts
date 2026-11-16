export { contentReader } from "./facts/content.js";
export {
  deriveManifestFacts,
  extOf,
  type SizeIssue,
  verifyContentSizes,
} from "./facts/manifest.js";
export {
  currentPreImage,
  type PreImageCoverage,
  type PreImageDrift,
  preImageCovers,
  verifyPreImage,
} from "./facts/preimage.js";
export { createRepoFacts, type RepoFactsOptions } from "./facts/repo.js";
export {
  compileSubjectRegex,
  GITHUB_ACTIONS_ISSUER,
  hasAmbientOidc,
  KEYLESS_BUNDLE_FIELD,
  type KeylessFailure,
  type KeylessPolicy,
  type KeylessVerdict,
  keylessPayload,
  keylessSignaturesOf,
  type SignKeylessOptions,
  type SigstoreBundleJson,
  signManifestKeyless,
  sigstoreModule,
  type VerifyKeylessOptions,
  verifyManifestKeyless,
} from "./keyless.js";
export * from "./predicates/index.js";
export { KeylessParams } from "./predicates/signature.js";
export {
  DEFAULT_GLOB_NOCASE,
  GLOB_MAX_CHARS,
  GLOB_MAX_WILDCARD_RUNS,
  GlobListSchema,
  type GlobMatcherOptions,
  GlobPatternSchema,
  globIssues,
  globMatcher,
  type Matcher,
} from "./predicates/util.js";
export {
  BUILTIN_PROFILE_INPUTS,
  builtinProfiles,
  checkIdentity,
  checksIdentical,
  type LoadProfileOptions,
  loadProfile,
  mergeChecks,
} from "./profile.js";
export { builtinRegistry, type ParamsResult, PredicateRegistry } from "./registry.js";
export {
  GUARD_POOL_SIZE,
  PREDICATE_TIMEOUT_MS,
  type RunChecksOptions,
  runChecks,
  sortFindings,
} from "./run.js";
export { SELF_PROTECT_HARD_GLOBS } from "./self-protect-globs.js";
export type {
  AnyPredicate,
  ContentReader,
  FactContext,
  GuardFacts,
  GuardOptions,
  ManifestFacts,
  Predicate,
  PredicateId,
  ProfileFacts,
  RepoFacts,
  Requirement,
} from "./types.js";
export { definePredicate } from "./types.js";
