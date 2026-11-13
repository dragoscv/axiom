/**
 * The check profile that judges a bundle (4.0, D-50 / S-1404): ONE loader for `plan check`,
 * `plan apply`, the MCP tools, the profile resource and `doctor`.
 *
 * Reality check #2: each of those called `loadProfile(name, { searchDirs })` on its own, so the
 * `checks` section of `.axiom/axiom.json` was read by nothing and the caller (over MCP: the
 * agent) picked the policy. Every entry point now goes through this function, which hands the
 * repository policy to the checks engine.
 */
import * as path from "node:path";
import { loadProfile } from "@codai/axiom-checks";
import type { Profile } from "@codai/axiom-schema";
import { resolvePolicy } from "./policy.js";

export interface CheckProfileOptions {
  /** Test seam for `~/.axiom`. */
  home?: string;
}

/**
 * `name` = the profile the caller or the plan asks for. `rootReal` undefined = no repository
 * (a bare `axiom_check` on a multi-root server): only the built-ins can be named.
 */
export async function loadCheckProfile(
  rootReal: string | undefined,
  name: string,
  opts: CheckProfileOptions = {},
): Promise<Profile> {
  if (rootReal === undefined) return loadProfile(name, { searchDirs: [] });
  const policy = await resolvePolicy(rootReal, opts.home === undefined ? {} : { home: opts.home });
  return loadProfile(name, {
    searchDirs: [path.join(rootReal, ".axiom", "profiles")],
    ...(policy.checks === undefined ? {} : { config: policy.checks }),
  });
}
