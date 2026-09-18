import { describe, expect, it } from "vitest";
import { createLogger, isLogLevel } from "./log.js";

describe("logger", () => {
  it("emits JSON lines with level/ts/msg and honours the threshold (default warn)", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l), now: () => "T" });
    log.error("e", { a: 1 });
    log.warn("w");
    log.info("i");
    log.debug("d");
    expect(lines).toEqual([
      '{"level":"error","ts":"T","msg":"e","a":1}\n',
      '{"level":"warn","ts":"T","msg":"w"}\n',
    ]);
  });

  it("debug level passes everything", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "debug", write: (l) => lines.push(l) });
    log.info("i");
    log.debug("d");
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it("isLogLevel", () => {
    expect(isLogLevel("warn")).toBe(true);
    expect(isLogLevel("verbose")).toBe(false);
    expect(isLogLevel(3)).toBe(false);
  });
});
