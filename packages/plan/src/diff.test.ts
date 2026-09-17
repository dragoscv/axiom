import { sha256Hex } from "@codai/axiom-canon";
import type { ManifestBody } from "@codai/axiom-schema";
import { describe, expect, it } from "vitest";
import { diffManifests } from "./diff.js";

type Art = ManifestBody["artifacts"][number];
const file = (path: string, content: string): Art => ({
  path,
  op: "create",
  mode: "0644",
  digest: { sha256: sha256Hex(content) },
});
const del = (path: string): Art => ({ path, op: "delete", mode: "0644" });

function body(artifacts: Art[]): ManifestBody {
  return {
    apiVersion: "axiom.dev/v2",
    kind: "Manifest",
    name: "d",
    profile: "default",
    planDigest: `sha256:${sha256Hex("p")}`,
    artifacts,
    checks: [],
    toolchain: { axiom: "2.0.0", emitters: {} },
  };
}

describe("diffManifests", () => {
  it.each([
    ["identical", [file("a", "1")], [file("a", "1")], { added: [], removed: [], changed: [] }],
    [
      "added",
      [file("a", "1")],
      [file("a", "1"), file("b", "2")],
      { added: ["b"], removed: [], changed: [] },
    ],
    [
      "removed",
      [file("a", "1"), file("b", "2")],
      [file("a", "1")],
      { added: [], removed: ["b"], changed: [] },
    ],
    [
      "changed",
      [file("a", "1")],
      [file("a", "2")],
      {
        added: [],
        removed: [],
        changed: [{ path: "a", from: `sha256:${sha256Hex("1")}`, to: `sha256:${sha256Hex("2")}` }],
      },
    ],
    [
      "file → delete",
      [file("a", "1")],
      [del("a")],
      {
        added: [],
        removed: [],
        changed: [{ path: "a", from: `sha256:${sha256Hex("1")}`, to: null }],
      },
    ],
    ["delete → delete", [del("a")], [del("a")], { added: [], removed: [], changed: [] }],
  ] as const)("%s", (_, a, b, expected) => {
    expect(diffManifests(body([...a]), body([...b]))).toEqual(expected);
  });

  it("sorts every list by UTF-8 path order", () => {
    const a = body([file("a", "1"), file("b", "1"), file("z", "1")]);
    const b = body([file("é", "1"), file("Z", "1"), file("a", "2"), file("b", "2")]);
    const d = diffManifests(a, b);
    expect(d.added).toEqual(["Z", "é"]);
    expect(d.removed).toEqual(["z"]);
    expect(d.changed.map((c) => c.path)).toEqual(["a", "b"]);
  });
});
