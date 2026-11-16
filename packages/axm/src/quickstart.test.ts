/**
 * QA-15 golden: the Plan documented in `docs/getting-started/quickstart.md` must compile to ONE
 * digest from either front-end.
 *
 * Two bugs made the documented pair disagree:
 *  - the `.axm` sample omitted the blank line before the heredoc terminator, so the heredoc body
 *    lost the trailing newline the JSON form has (`"export const hi = () => 'hi';\n"`);
 *  - the JSON sample still carries the 2.x `apiVersion` while the `.axm` front-end emits the
 *    canonical one (D-41) — a documentation bug (DX-9), reported as a Request.
 *
 * The digests below are pinned: if a change moves them, that change alters what the documented
 * example content-addresses, and it must be re-pinned deliberately.
 */

import { compilePlan } from "@codai/axiom-plan";
import { API_VERSION, PlanSchema } from "@codai/axiom-schema";
import { describe, expect, it } from "vitest";
import { parseAxm } from "./index.js";

/** Verbatim from the quickstart (only `apiVersion` is the canonical one, see the file comment). */
const DOC_JSON = {
  apiVersion: API_VERSION,
  kind: "Plan",
  name: "hello",
  intent: "Add a greeting module and document it.",
  artifacts: [
    {
      path: "src/hello.ts",
      source: { type: "inline", content: "export const hi = () => 'hi';\n" },
    },
    {
      path: "README.md",
      op: "overwrite",
      source: { type: "inline", content: "# hello\n" },
    },
  ],
  checks: [{ id: "no-secrets", predicate: "content.noSecrets", params: {} }],
};

/** The same Plan as `.axm`, with the empty line the heredoc rule requires before the terminator. */
const DOC_AXM = `axiom "2"

plan hello {
  intent "Add a greeting module and document it."
  artifact "src/hello.ts" {
    inline <<TS
export const hi = () => 'hi';

TS
  }
  artifact "README.md" {
    op overwrite
    inline <<MD
# hello

MD
  }
  check no-secrets using content.noSecrets {}
}
`;

describe("quickstart golden (QA-15)", () => {
  it("the documented .axm carries exactly the documented JSON content", () => {
    const parsed = parseAxm(DOC_AXM);
    expect(parsed.diagnostics).toEqual([]);
    expect(PlanSchema.parse(parsed.plan)).toStrictEqual(PlanSchema.parse(DOC_JSON));
  });

  it("both front-ends compile the documented example to the same pinned digest", async () => {
    const fromJson = await compilePlan(DOC_JSON);
    const fromAxm = await compilePlan(parseAxm(DOC_AXM).plan);
    expect(fromAxm.bundle.manifestDigest).toBe(fromJson.bundle.manifestDigest);
    expect(fromAxm.bundle.manifest.planDigest).toBe(fromJson.bundle.manifest.planDigest);
    expect(fromJson.bundle.manifestDigest).toBe(
      "sha256:ca4c65ee7e649e727b18eb7a9fc2ad0c32be1e3adcad7574803bb9d1752b8a06",
    );
    expect(fromJson.bundle.manifest.planDigest).toBe(
      "sha256:2eda30ceeccf1c8e9caa80f7a1612744bd67c98a581e91e1d8dec2a6d636925e",
    );
  });
});
