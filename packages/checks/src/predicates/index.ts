import type { AnyPredicate } from "../types.js";
import { exprCel } from "./cel.js";
import { contentEncodingUtf8, contentMaxBytes, contentNoSecrets } from "./content.js";
import { depsDeny, depsMax } from "./deps.js";
import { guardExternal } from "./guard.js";
import {
  manifestMaxArtifacts,
  manifestMaxTotalBytes,
  manifestNoDeletes,
  manifestRequireSigned,
} from "./manifest.js";
import { pathAllow, pathDeny, pathReservedNames } from "./path.js";
import { repoNoOverwriteOf, repoRequireCompanion } from "./repo.js";

export {
  CEL_ALLOWED_FUNCTIONS,
  CEL_LIMITS,
  CEL_VARIABLES,
  CelParams,
  type CelParamsT,
  EVAL_BUDGET_MS,
  EXPRESSION_MAX_CHARS,
  evaluateCel,
} from "./cel.js";
export { SECRET_PATTERN_NAMES, SECRET_PATTERNS } from "./content.js";
export {
  GuardExternalParams,
  type GuardExternalParamsT,
  type GuardOutput,
  GuardOutputSchema,
  parseLegacyText,
  resolveGuardCommand,
} from "./guard.js";
export {
  contentEncodingUtf8,
  contentMaxBytes,
  contentNoSecrets,
  depsDeny,
  depsMax,
  exprCel,
  guardExternal,
  manifestMaxArtifacts,
  manifestMaxTotalBytes,
  manifestNoDeletes,
  manifestRequireSigned,
  pathAllow,
  pathDeny,
  pathReservedNames,
  repoNoOverwriteOf,
  repoRequireCompanion,
};

export const BUILTIN_PREDICATES: readonly AnyPredicate[] = [
  pathAllow,
  pathDeny,
  pathReservedNames,
  contentNoSecrets,
  contentMaxBytes,
  contentEncodingUtf8,
  manifestMaxArtifacts,
  manifestMaxTotalBytes,
  manifestRequireSigned,
  manifestNoDeletes,
  depsMax,
  depsDeny,
  repoNoOverwriteOf,
  repoRequireCompanion,
  guardExternal,
  exprCel,
];
