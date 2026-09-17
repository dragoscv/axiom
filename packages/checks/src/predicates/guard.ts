import { z } from "zod";
import { definePredicate } from "../types.js";
import { finding } from "./util.js";

/** §3.2 params, accepted so profiles written for v2.1 validate today. */
export const GuardExternalParams = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.enum(["root", "staging"]).optional(),
    timeoutMs: z.int().positive().max(60_000).default(30_000),
    env: z.record(z.string(), z.string()).optional(),
    stdin: z.enum(["bundle", "manifest", "none"]).default("bundle"),
  })
  .strict();

/** v2.1 feature. In v2.0 it never runs anything and always fails closed. */
export const guardExternal = definePredicate<z.infer<typeof GuardExternalParams>>({
  id: "guard.external",
  params: GuardExternalParams,
  requires: ["guard"],
  async run(_ctx, { command }) {
    return [
      finding({
        id: "guard.external",
        predicate: "guard.external",
        message: "external guards are not enabled in v2.0",
        facts: { command, code: "ERR_UNSUPPORTED_OP", __provider: true },
      }),
    ];
  },
});
