import { describe, it } from "node:test";
import assert from "node:assert";
import { evalCheck, type PolicyContext } from "../dist/index.js";

describe("Check Evaluator", () => {
  const baseCtx: PolicyContext = {
    metrics: {
      latency_p50_ms: 45,
      monthly_budget_usd: 2,
      pii_leak: false,
      cold_start_ms: 80,
      frontend_bundle_kb: 150
    },
    artifacts: [],
    capabilities: [
      { kind: "fs", args: ["./out"] },
      { kind: "net", args: ["http"] }
    ]
  };

  describe("Numeric comparisons", () => {
    it("should evaluate <= operator", async () => {
      const result = await evalCheck(baseCtx, "latency_p50_ms <= 80");
      assert.strictEqual(result, true);
    });

    it("should evaluate < operator", async () => {
      const result = await evalCheck(baseCtx, "latency_p50_ms < 50");
      assert.strictEqual(result, true);
    });

    it("should evaluate >= operator", async () => {
      const result = await evalCheck(baseCtx, "monthly_budget_usd >= 2");
      assert.strictEqual(result, true);
    });

    it("should evaluate > operator", async () => {
      const result = await evalCheck(baseCtx, "frontend_bundle_kb > 100");
      assert.strictEqual(result, true);
    });

    it("should fail on false condition", async () => {
      const result = await evalCheck(baseCtx, "latency_p50_ms > 100");
      assert.strictEqual(result, false);
    });
  });

  describe("Boolean comparisons", () => {
    it("should evaluate == for boolean", async () => {
      const result = await evalCheck(baseCtx, "pii_leak == false");
      assert.strictEqual(result, true);
    });

    it("should evaluate != for boolean", async () => {
      const result = await evalCheck(baseCtx, "pii_leak != true");
      assert.strictEqual(result, true);
    });
  });

  describe("Function calls", () => {
    it("should evaluate scan.artifacts.no_personal_data()", async () => {
      const ctx = {
        ...baseCtx,
        artifacts: [
          { path: "test.txt", content: "This is clean content without PII" }
        ]
      };
      const result = await evalCheck(ctx, "scan.artifacts.no_personal_data()");
      assert.strictEqual(result, true);
    });

    it("should detect email as PII", async () => {
      const ctx = {
        ...baseCtx,
        artifacts: [
          { path: "test.txt", content: "Contact: user@example.com for info" }
        ]
      };
      const result = await evalCheck(ctx, "scan.artifacts.no_personal_data()");
      assert.strictEqual(result, false);
    });

    it("should detect phone as PII", async () => {
      const ctx = {
        ...baseCtx,
        artifacts: [
          { path: "test.txt", content: "Call us: 0712345678" }
        ]
      };
      const result = await evalCheck(ctx, "scan.artifacts.no_personal_data()");
      assert.strictEqual(result, false);
    });

    it("should detect CNP as PII", async () => {
      const ctx = {
        ...baseCtx,
        artifacts: [
          { path: "test.txt", content: "CNP: 1850101123456" }
        ]
      };
      const result = await evalCheck(ctx, "scan.artifacts.no_personal_data()");
      assert.strictEqual(result, false);
    });

    it("should require net capability for http.healthy", async () => {
      const ctx = {
        ...baseCtx,
        capabilities: [{ kind: "fs", args: ["./out"] }]
      };
      
      await assert.rejects(
        async () => await evalCheck(ctx, 'http.healthy("http://example.com")'),
        /requires capability net\('http'\)/
      );
    });
  });

  describe("Error handling", () => {
    it("should throw on unknown function", async () => {
      await assert.rejects(
        async () => await evalCheck(baseCtx, "unknown.function()"),
        /Unknown function/
      );
    });

    it("should throw on unknown operator", async () => {
      const ctx = {
        ...baseCtx,
        metrics: { ...baseCtx.metrics }
      };
      
      // Note: Our tokenizer doesn't support ===, so this should fail
      await assert.rejects(
        async () => await evalCheck(ctx, "latency_p50_ms === 45"),
        /Unexpected character|Cannot evaluate/
      );
    });
  });
});
