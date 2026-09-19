export { contentReader } from "./facts/content.js";
export { deriveManifestFacts, extOf } from "./facts/manifest.js";
export { currentPreImage, type PreImageDrift, verifyPreImage } from "./facts/preimage.js";
export { createRepoFacts, type RepoFactsOptions } from "./facts/repo.js";
export * from "./predicates/index.js";
export {
  BUILTIN_PROFILE_INPUTS,
  builtinProfiles,
  type LoadProfileOptions,
  loadProfile,
  mergeChecks,
} from "./profile.js";
export { builtinRegistry, type ParamsResult, PredicateRegistry } from "./registry.js";
export { GUARD_POOL_SIZE, type RunChecksOptions, runChecks, sortFindings } from "./run.js";
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
