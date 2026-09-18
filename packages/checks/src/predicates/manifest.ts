import { z } from "zod";
import { definePredicate } from "../types.js";
import { finding } from "./util.js";

const Max = z.object({ max: z.int().nonnegative() }).strict();
const Empty = z.object({}).strict();

export const manifestMaxArtifacts = definePredicate<z.infer<typeof Max>>({
  id: "manifest.maxArtifacts",
  params: Max,
  requires: ["manifest"],
  async run(ctx, { max }) {
    const n = ctx.facts.manifest.artifactCount;
    if (n <= max) return [];
    return [
      finding({
        id: "manifest.maxArtifacts",
        predicate: "manifest.maxArtifacts",
        message: `manifest has ${n} artifacts, limit ${max}`,
        facts: { artifactCount: n, max },
      }),
    ];
  },
});

export const manifestMaxTotalBytes = definePredicate<z.infer<typeof Max>>({
  id: "manifest.maxTotalBytes",
  params: Max,
  requires: ["manifest"],
  async run(ctx, { max }) {
    const n = ctx.facts.manifest.totalBytes;
    if (n <= max) return [];
    return [
      finding({
        id: "manifest.maxTotalBytes",
        predicate: "manifest.maxTotalBytes",
        message: `manifest totals ${n} bytes, limit ${max}`,
        facts: { totalBytes: n, max },
      }),
    ];
  },
});

export const manifestNoDeletes = definePredicate<Record<string, never>>({
  id: "manifest.noDeletes",
  params: Empty,
  requires: ["manifest"],
  async run(ctx) {
    return ctx.manifest.artifacts
      .filter((a) => a.op === "delete")
      .map((a) =>
        finding({
          id: "manifest.noDeletes",
          predicate: "manifest.noDeletes",
          path: a.path,
          message: "delete operations are not allowed",
        }),
      );
  },
});
