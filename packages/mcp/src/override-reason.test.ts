import { describe, expect, it } from "vitest";
import { isOverrideReason } from "./gate.js";

describe("isOverrideReason (≥ 3 words with letters AND ≥ 12 letters)", () => {
  it.each([
    "supercalifragilisticexpialidocious",
    "owner-approved-the-env-file-write",
    "twowords onlyherebutlong",
  ])("rejects %j: enough letters but fewer than 3 words", (reason) => {
    expect(isOverrideReason(reason)).toBe(false);
  });

  it.each(["owner approved writing the env file", "user asked for this reset"])(
    "accepts %j",
    (reason) => {
      expect(isOverrideReason(reason)).toBe(true);
    },
  );
});
