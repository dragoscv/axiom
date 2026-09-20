import { canonicalize } from "@codai/axiom-canon";
import { compilePlan } from "@codai/axiom-plan";
import { AxiomError, type PlanInput } from "@codai/axiom-schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PlanSessionStore, TaskStore } from "./tasks.js";

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AxiomError) return e.code;
    throw e;
  }
  throw new Error("did not throw");
};

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("TaskStore", () => {
  it("working → completed with the result; describe() reports elapsed", async () => {
    const c = clock();
    const store = new TaskStore({ now: c.now });
    let release!: (v: string) => void;
    const rec = store.start("t", () => new Promise<string>((r) => (release = r)));
    expect(rec.status).toBe("working");
    expect(store.describe(rec)).toMatchObject({ taskId: rec.taskId, status: "working" });
    c.advance(250);
    release("done");
    await tick();
    expect(rec.status).toBe("completed");
    expect(rec.result).toBe("done");
    expect(store.describe(rec).elapsedMs).toBe(250);
  });

  it("a rejected AxiomError becomes failed with its closed code; other errors → ERR_INTERNAL", async () => {
    const store = new TaskStore();
    const a = store.start("t", async () => {
      throw new AxiomError("ERR_ROOT_NOT_ALLOWED", "nope");
    });
    const b = store.start("t", async () => {
      throw new TypeError("boom");
    });
    await tick();
    expect(a.status).toBe("failed");
    expect(a.error?.code).toBe("ERR_ROOT_NOT_ALLOWED");
    expect(b.status).toBe("failed");
    expect(b.error).toEqual({ code: "ERR_INTERNAL", message: "boom" });
  });

  it("cancel aborts the signal, marks cancelled, and a late settle does not overwrite it", async () => {
    const store = new TaskStore();
    let seen: AbortSignal | undefined;
    let release!: () => void;
    const rec = store.start("t", (signal) => {
      seen = signal;
      return new Promise<string>((r) => (release = () => r("late")));
    });
    store.cancel(rec.taskId);
    expect(seen?.aborted).toBe(true);
    expect(rec.status).toBe("cancelled");
    expect(rec.error?.code).toBe("ERR_TASK_CANCELLED");
    release();
    await tick();
    expect(rec.status).toBe("cancelled");
    expect(rec.result).toBeUndefined();
    // idempotent
    expect(store.cancel(rec.taskId).status).toBe("cancelled");
  });

  it("unknown id → ERR_TASK_NOT_FOUND; terminal tasks are swept after ttlMs", async () => {
    const c = clock();
    const store = new TaskStore({ now: c.now, ttlMs: 1_000 });
    expect(codeOf(() => store.get("nope"))).toBe("ERR_TASK_NOT_FOUND");
    const rec = store.start("t", async () => 1);
    await tick();
    expect(store.get(rec.taskId).status).toBe("completed");
    c.advance(999);
    expect(store.get(rec.taskId).status).toBe("completed");
    c.advance(2);
    expect(codeOf(() => store.get(rec.taskId))).toBe("ERR_TASK_NOT_FOUND");
    expect(store.size).toBe(0);
  });

  it("working tasks are never swept; maxWorking refuses the (n+1)th start with ERR_EBUSY", () => {
    const c = clock();
    const store = new TaskStore({ now: c.now, ttlMs: 10, maxWorking: 2 });
    const never = () => new Promise<never>(() => undefined);
    store.start("t", never);
    store.start("t", never);
    c.advance(10_000);
    expect(codeOf(() => store.start("t", never))).toBe("ERR_EBUSY");
    expect(store.size).toBe(2);
    store.abortAll();
    expect(store.start("t", never).status).toBe("working");
  });
});

describe("PlanSessionStore", () => {
  const header = { name: "chunked", intent: "session test" };
  const art = (path: string, content = "x") => ({
    path,
    mode: "0644" as const,
    op: "create" as const,
    source: { type: "inline" as const, content },
  });

  it("begin → add → seal assembles the Plan and consumes the session", () => {
    const store = new PlanSessionStore();
    const s = store.begin(header);
    store.add(s.sessionId, [art("a.ts"), art("b.ts")], 10);
    store.add(s.sessionId, [art("c.ts")], 5);
    const { plan, session } = store.seal(s.sessionId);
    expect(session.bytes).toBe(15);
    expect(plan).toMatchObject({ apiVersion: "axiom.dev/v2", kind: "Plan", name: "chunked" });
    expect(plan.artifacts.map((a) => a.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(store.size).toBe(0);
    expect(codeOf(() => store.get(s.sessionId))).toBe("ERR_TASK_NOT_FOUND");
    expect(codeOf(() => store.add(s.sessionId, [art("d.ts")], 1))).toBe("ERR_TASK_NOT_FOUND");
  });

  it("duplicate path across chunks → ERR_INVALID_PLAN and the chunk is not applied", () => {
    const store = new PlanSessionStore();
    const s = store.begin(header);
    store.add(s.sessionId, [art("a.ts")], 1);
    expect(codeOf(() => store.add(s.sessionId, [art("b.ts"), art("a.ts")], 1))).toBe(
      "ERR_INVALID_PLAN",
    );
    expect(store.get(s.sessionId).artifacts).toHaveLength(1);
  });

  it("artifact and byte budgets → ERR_PLAN_SESSION_STATE", () => {
    const store = new PlanSessionStore({ maxArtifacts: 2, maxBytes: 100 });
    const s = store.begin(header);
    expect(codeOf(() => store.add(s.sessionId, [art("a"), art("b"), art("c")], 1))).toBe(
      "ERR_PLAN_SESSION_STATE",
    );
    expect(codeOf(() => store.add(s.sessionId, [art("a")], 101))).toBe("ERR_PLAN_SESSION_STATE");
    store.add(s.sessionId, [art("a")], 100);
    expect(codeOf(() => store.add(s.sessionId, [art("b")], 1))).toBe("ERR_PLAN_SESSION_STATE");
  });

  it("maxOpen refuses with ERR_EBUSY; idle sessions expire after ttlMs", () => {
    const c = clock();
    const store = new PlanSessionStore({ now: c.now, ttlMs: 1_000, maxOpen: 1 });
    const s = store.begin(header);
    expect(codeOf(() => store.begin(header))).toBe("ERR_EBUSY");
    c.advance(900);
    store.add(s.sessionId, [art("a")], 1); // touches
    c.advance(900);
    expect(store.get(s.sessionId).artifacts).toHaveLength(1);
    c.advance(101);
    expect(codeOf(() => store.get(s.sessionId))).toBe("ERR_TASK_NOT_FOUND");
    expect(store.begin(header).sessionId).toBeDefined();
  });

  it("abandon drops an open session; unknown id is a no-op", () => {
    const store = new PlanSessionStore();
    const s = store.begin(header);
    expect(store.abandon(s.sessionId)).toBe(true);
    expect(store.abandon(s.sessionId)).toBe(false);
    expect(store.size).toBe(0);
  });
});

// --- property: sealed digest == one-shot digest (S-406 acceptance) ---------------------------------

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const segment = fc
  .stringMatching(/^[a-z0-9_-]{1,10}$/)
  .filter((s) => !/[.\s]$/.test(s) && !RESERVED.test(s));
const relPath = fc
  .tuple(fc.array(segment, { minLength: 1, maxLength: 3 }), fc.constantFrom("", ".ts", ".md"))
  .map(([segs, e]) => segs.join("/") + e);
const artifactArb = fc
  .tuple(relPath, fc.string({ minLength: 0, maxLength: 120, unit: "grapheme" }))
  .map(([path, content]): PlanInput["artifacts"][number] => ({
    path,
    source: { type: "inline", content },
  }));
const planArb = fc
  .uniqueArray(artifactArb, { minLength: 1, maxLength: 24, selector: (a) => a.path })
  .map(
    (artifacts): PlanInput => ({
      apiVersion: "axiom.dev/v2",
      kind: "Plan",
      name: "prop",
      intent: "chunked == one-shot",
      artifacts,
    }),
  );
/** Split `n` items into random non-empty chunks. */
const chunkingArb = (n: number) =>
  fc
    .array(fc.integer({ min: 1, max: Math.max(1, n) }), { minLength: 1, maxLength: n })
    .map((sizes) => {
      const out: number[] = [];
      let left = n;
      for (const s of sizes) {
        if (left <= 0) break;
        const take = Math.min(s, left);
        out.push(take);
        left -= take;
      }
      if (left > 0) out.push(left);
      return out;
    });

describe("chunked plan sessions compile to the one-shot digest", () => {
  it("any chunking of any small plan seals to the same manifestDigest, blobs and canonical body", async () => {
    await fc.assert(
      fc.asyncProperty(
        planArb.chain((plan) => fc.tuple(fc.constant(plan), chunkingArb(plan.artifacts.length))),
        async ([plan, chunks]) => {
          const oneShot = await compilePlan(plan);

          const store = new PlanSessionStore();
          const { artifacts, apiVersion: _a, kind: _k, ...header } = plan;
          const s = store.begin(header);
          let i = 0;
          for (const size of chunks) {
            const slice = artifacts.slice(i, i + size);
            i += size;
            // the tool validates each chunk with PlanArtifactSchema before add(); mirror the defaults here
            store.add(
              s.sessionId,
              slice.map((a) => ({ ...a, mode: "0644" as const, op: "create" as const })) as never,
              Buffer.byteLength(JSON.stringify(slice), "utf8"),
            );
          }
          expect(i).toBe(artifacts.length);
          const sealed = await compilePlan(store.seal(s.sessionId).plan);

          expect(sealed.bundle.manifestDigest).toBe(oneShot.bundle.manifestDigest);
          expect(canonicalize(sealed.bundle.manifest)).toBe(canonicalize(oneShot.bundle.manifest));
          expect(canonicalize(sealed.bundle.blobs)).toBe(canonicalize(oneShot.bundle.blobs));
        },
      ),
      { numRuns: 50 },
    );
  });
});
