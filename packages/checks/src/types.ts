import type {
  Finding,
  ManifestBody,
  ManifestBundle,
  ProfileFacts,
  RelPath,
} from "@codai/axiom-schema";
import type { z } from "zod";

export type { ProfileFacts };

export interface ManifestFacts {
  artifactCount: number;
  totalBytes: number;
  paths: string[];
  byExt: Record<string, number>;
  hasDeletes: boolean;
  signed: boolean;
}

export type ContentReader = (path: RelPath) => Promise<Uint8Array | undefined>;

/** Offline repository facts; present only when a root is authorised (§3.1). */
export interface RepoFacts {
  exists(path: RelPath): Promise<boolean>;
  read(path: RelPath, max?: number): Promise<Uint8Array | undefined>;
  /** picomatch over a lazily-built index, roughly .gitignore-aware. */
  glob(pattern: string): Promise<string[]>;
  packageJson: Record<string, unknown> | undefined;
  gitHead?: string;
  gitDirty?: boolean;
}

/** Runner-provided guard settings (§3.2); present iff the server enabled guards. */
export interface GuardFacts {
  /** `--allow-guards` was given at startup. */
  enabled: boolean;
  /** realpath'd authorised root; relative commands resolve under `<root>/scripts/`. */
  root: string;
  /** Absolute executables allowed as `command` (`--guard-allowlist`). */
  allowlist: readonly string[];
  /** Apply staging dir, when the runner has one (`cwd: "staging"`). */
  stagingDir?: string;
}

/** Options threaded from the server flags into `runChecks` (§3.2). */
export interface GuardOptions {
  allowGuards?: boolean;
  guardAllowlist?: readonly string[];
  stagingDir?: string;
}

/** Everything a predicate may read. Frozen before predicates run. */
export interface FactContext {
  manifest: ManifestBody;
  bundle: ManifestBundle;
  facts: {
    manifest: ManifestFacts;
    /** From blobs/CAS only; never network. */
    content: ContentReader;
    repo?: RepoFacts;
    guard?: GuardFacts;
    profile: ProfileFacts;
  };
}

export type PredicateId = `${string}.${string}`;
export type Requirement = "manifest" | "content" | "repo" | "guard";

export interface Predicate<P = unknown> {
  readonly id: PredicateId;
  readonly params: z.ZodType<P>;
  readonly requires: readonly Requirement[];
  run(ctx: FactContext, params: P): Promise<Finding[]>;
}

/** Erase the param type so heterogenous predicates fit in one registry. */
export type AnyPredicate = Predicate<unknown>;

export function definePredicate<P>(p: Predicate<P>): AnyPredicate {
  return p as unknown as AnyPredicate;
}
