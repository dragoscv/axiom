/**
 * S-406 tool surface: axiom_check_start / axiom_task_get / axiom_task_cancel and
 * axiom_plan_begin / axiom_plan_add / axiom_plan_seal, exercised through the MCP client.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckReport, ManifestBundle, PlanInput } from "@codai/axiom-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TASK_POLL_INTERVAL_MS, TASK_TTL_MS, TaskStore } from "./tasks.js";
import { type Harness, harness, makePlan, structured, textOf, tmpRepo } from "./test-helpers.js";
import { BUNDLE_BYTES_MAX } from "./tools.js";

let repo: Awaited<ReturnType<typeof tmpRepo>>;
let h: Harness;
let tasks: TaskStore;

/** A profile that runs `<root>/scripts/<script>` as a guard with the given timeout. */
async function guardProfile(root: string, script: string, timeoutMs: number, body: string) {
  await mkdir(join(root, ".axiom", "profiles"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "scripts", script), body);
  await writeFile(
    join(root, ".axiom", "profiles", "guarded.json"),
    JSON.stringify({
      apiVersion: "axiom.dev/v2",
      kind: "Profile",
      name: "guarded",
      extends: "permissive",
      facts: { allowRepo: true, allowGuards: true },
      checks: [
        {
          id: "g",
          predicate: "guard.external",
          params: { command: script, timeoutMs, stdin: "none" },
          severity: "error",
        },
      ],
    }),
  );
}

const HANG = "setInterval(() => {}, 1000);\n";
const SLOW_OK = "setTimeout(() => process.stdout.write(JSON.stringify({ ok: true })), 300);\n";

beforeEach(async () => {
  repo = await tmpRepo("axiom-mcp-tasks-");
  tasks = new TaskStore({ pollIntervalMs: 20 });
  h = await harness([repo.root], { tasks, guards: { allowGuards: true, guardAllowlist: [] } });
});
afterEach(async () => {
  tasks.abortAll();
  await h.close();
  await repo.cleanup();
});

const compiled = async () =>
  structured<ManifestBundle>(
    await h.call("axiom_plan_compile", {
      plan: makePlan({ "src/a.ts": "export const a = 1;\n" }),
      root: repo.root,
    }),
  );

async function pollUntilTerminal(taskId: string, budgetMs = 15_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await h.call("axiom_task_get", { taskId });
    expect(r.isError).toBeUndefined();
    const out = structured<{ status: string; result?: CheckReport; error?: { code: string } }>(r);
    if (out.status !== "working") return out;
    if (Date.now() - t0 > budgetMs) throw new Error("task did not finish in time");
    await new Promise((res) => setTimeout(res, 20));
  }
}

describe("axiom_check_start / axiom_task_get", () => {
  it("returns a working descriptor immediately; polling yields the CheckReport (guard beyond the old 60 s cap)", async () => {
    await guardProfile(repo.root, "slow-ok.mjs", 5 * 60_000, SLOW_OK);
    const bundle = await compiled();
    const t0 = Date.now();
    const start = await h.call("axiom_check_start", {
      bundle,
      root: repo.root,
      profile: "guarded",
    });
    expect(start.isError).toBeUndefined();
    const desc = structured<{
      taskId: string;
      status: string;
      tool: string;
      pollIntervalMs: number;
      ttlMs: number;
    }>(start);
    expect(Date.now() - t0).toBeLessThan(250); // did not wait for the 300 ms guard
    expect(desc).toMatchObject({
      status: "working",
      tool: "axiom_check",
      pollIntervalMs: 20,
      ttlMs: TASK_TTL_MS,
    });
    expect(desc.taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(textOf(start))).toMatchObject({ taskId: desc.taskId, status: "working" });

    const working = structured<{ status: string; result?: unknown }>(
      await h.call("axiom_task_get", { taskId: desc.taskId }),
    );
    expect(working.status).toBe("working");
    expect(working.result).toBeUndefined();

    const done = await pollUntilTerminal(desc.taskId);
    expect(done.status).toBe("completed");
    expect(done.result?.kind).toBe("CheckReport");
    expect(done.result?.verdict).toBe("pass");
    expect(done.result?.providers.find((p) => p.name === "guard")?.status).toBe("ok");
    expect(done.result?.manifestDigest).toBe(bundle.manifestDigest);
    // the report is also stored under the root like a sync axiom_check
    const stored = await h.client.readResource({
      uri: `axiom://report/${bundle.manifestDigest.slice("sha256:".length)}`,
    });
    expect(stored.contents).toHaveLength(1);
  });

  it("a completed task's summary text is the report summary, not the descriptor only", async () => {
    const bundle = await compiled();
    const { taskId } = structured<{ taskId: string }>(
      await h.call("axiom_check_start", { bundle, root: repo.root }),
    );
    await pollUntilTerminal(taskId);
    const r = await h.call("axiom_task_get", { taskId });
    const summary = JSON.parse(textOf(r)) as { status: string; result?: { verdict: string } };
    expect(summary.status).toBe("completed");
    expect(summary.result?.verdict).toBe("pass");
  });

  it("validation errors surface synchronously as isError, never as a task", async () => {
    const bad = await h.call("axiom_check_start", { bundle: { nope: true }, root: repo.root });
    expect(bad.isError).toBe(true);
    expect(structured<{ code: string }>(bad).code).toBe("ERR_INVALID_MANIFEST");
    const outside = await h.call("axiom_check_start", {
      bundle: await compiled(),
      root: join(repo.root, "..", "elsewhere"),
    });
    expect(outside.isError).toBe(true);
    expect(structured<{ code: string }>(outside).code).toBe("ERR_ROOT_NOT_ALLOWED");
    expect(tasks.size).toBe(0);
  });

  it("unknown taskId → ERR_TASK_NOT_FOUND for get and cancel", async () => {
    for (const tool of ["axiom_task_get", "axiom_task_cancel"]) {
      const r = await h.call(tool, { taskId: "00000000-0000-0000-0000-000000000000" });
      expect(r.isError).toBe(true);
      expect(structured<{ code: string }>(r).code).toBe("ERR_TASK_NOT_FOUND");
    }
  });

  it("a profile that fails to load makes the task `failed` with the closed code", async () => {
    const bundle = await compiled();
    const { taskId } = structured<{ taskId: string }>(
      await h.call("axiom_check_start", { bundle, root: repo.root, profile: "no-such-profile" }),
    );
    const done = await pollUntilTerminal(taskId);
    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe("ERR_INVALID_PROFILE");
    expect(done.result).toBeUndefined();
  });
});

describe("axiom_task_cancel", () => {
  it("kills a hanging guard: task ends cancelled with ERR_TASK_CANCELLED long before timeoutMs", async () => {
    await guardProfile(repo.root, "hang.mjs", 10 * 60_000, HANG);
    const bundle = await compiled();
    const { taskId } = structured<{ taskId: string }>(
      await h.call("axiom_check_start", { bundle, root: repo.root, profile: "guarded" }),
    );
    await new Promise((r) => setTimeout(r, 150)); // let the child spawn
    const t0 = Date.now();
    const c = await h.call("axiom_task_cancel", { taskId });
    expect(c.isError).toBeUndefined();
    expect(structured<{ status: string }>(c).status).toBe("cancelled");
    const got = structured<{ status: string; error?: { code: string }; result?: unknown }>(
      await h.call("axiom_task_get", { taskId }),
    );
    expect(got.status).toBe("cancelled");
    expect(got.error?.code).toBe("ERR_TASK_CANCELLED");
    expect(got.result).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(5_000);
    // the underlying work settles (child killed) without flipping the status back
    const rec = tasks.get(taskId);
    expect(rec.controller.signal.aborted).toBe(true);
    // idempotent
    expect(
      structured<{ status: string }>(await h.call("axiom_task_cancel", { taskId })).status,
    ).toBe("cancelled");
  });

  it("cancelling a completed task leaves it completed", async () => {
    const bundle = await compiled();
    const { taskId } = structured<{ taskId: string }>(
      await h.call("axiom_check_start", { bundle, root: repo.root }),
    );
    await pollUntilTerminal(taskId);
    const c = structured<{ status: string }>(await h.call("axiom_task_cancel", { taskId }));
    expect(c.status).toBe("completed");
  });
});

describe("axiom_plan_begin / add / seal", () => {
  const header = { name: "chunked", intent: "sealed == one-shot" };
  const files: Record<string, string> = {};
  for (let i = 0; i < 12; i++) files[`src/f${i}.ts`] = `export const f${i} = ${i};\n`;
  const plan: PlanInput = makePlan(files, { name: header.name });
  plan.intent = header.intent;

  it("sealed bundle is byte-identical to axiom_plan_compile of the same Plan", async () => {
    const one = structured<ManifestBundle>(await h.call("axiom_plan_compile", { plan }));

    const begin = await h.call("axiom_plan_begin", header);
    expect(begin.isError).toBeUndefined();
    const s = structured<{ sessionId: string; artifacts: number; bytes: number; ttlMs: number }>(
      begin,
    );
    expect(s.artifacts).toBe(0);
    expect(s.bytes).toBe(0);

    const arts = plan.artifacts;
    for (const chunk of [arts.slice(0, 5), arts.slice(5, 6), arts.slice(6)]) {
      const r = await h.call("axiom_plan_add", { sessionId: s.sessionId, artifacts: chunk });
      expect(r.isError).toBeUndefined();
    }
    const after = structured<{ artifacts: number; bytes: number }>(
      await h.call("axiom_plan_add", {
        sessionId: s.sessionId,
        artifacts: [{ path: "extra.md", source: { type: "inline", content: "# x\n" } }],
      }),
    );
    expect(after.artifacts).toBe(13);
    expect(after.bytes).toBeGreaterThan(0);

    const sealed = await h.call("axiom_plan_seal", { sessionId: s.sessionId, root: repo.root });
    expect(sealed.isError).toBeUndefined();
    const sb = structured<ManifestBundle>(sealed);
    const oneWithExtra = structured<ManifestBundle>(
      await h.call("axiom_plan_compile", {
        root: repo.root, // a root adds `preImage` entries (S-402) — compare like with like
        plan: {
          ...plan,
          artifacts: [
            ...plan.artifacts,
            { path: "extra.md", source: { type: "inline", content: "# x\n" } },
          ],
        },
      }),
    );
    expect(sb.manifestDigest).toBe(oneWithExtra.manifestDigest);
    expect(sb.manifest).toEqual(oneWithExtra.manifest);
    expect(sb.blobs).toEqual(oneWithExtra.blobs);
    expect(sb.manifestDigest).not.toBe(one.manifestDigest); // extra.md changed it — the check is not vacuous
    // stored under the root like a compile with root
    const stored = await h.client.readResource({
      uri: `axiom://manifest/${sb.manifestDigest.slice("sha256:".length)}`,
    });
    expect(stored.contents).toHaveLength(1);
    // consumed
    const again = await h.call("axiom_plan_seal", { sessionId: s.sessionId });
    expect(again.isError).toBe(true);
    expect(structured<{ code: string }>(again).code).toBe("ERR_TASK_NOT_FOUND");
  });

  it("assembles a Plan whose one-shot JSON exceeds the 4 MiB call cap", async () => {
    // 20 artifacts × 250 KiB ≈ 5 MiB of plan JSON: too big for one call, fine in chunks + CAS.
    const big = "x".repeat(250 * 1024);
    const artifacts = Array.from({ length: 20 }, (_, i) => ({
      path: `big/${i}.txt`,
      source: { type: "inline" as const, content: big },
    }));
    const whole = { ...makePlan({}, { name: "big" }), artifacts };
    expect(Buffer.byteLength(JSON.stringify(whole), "utf8")).toBeGreaterThan(BUNDLE_BYTES_MAX);
    const tooBig = await h.call("axiom_plan_compile", {
      plan: whole,
      store: "cas",
      root: repo.root,
    });
    expect(tooBig.isError).toBe(true);
    expect(structured<{ code: string }>(tooBig).code).toBe("ERR_BUNDLE_TOO_LARGE");

    const { sessionId } = structured<{ sessionId: string }>(
      await h.call("axiom_plan_begin", { name: "big", intent: "mcp test fixture" }),
    );
    for (let i = 0; i < artifacts.length; i += 4) {
      const r = await h.call("axiom_plan_add", { sessionId, artifacts: artifacts.slice(i, i + 4) });
      expect(r.isError).toBeUndefined();
    }
    const sealed = await h.call("axiom_plan_seal", { sessionId, store: "cas", root: repo.root });
    expect(sealed.isError).toBeUndefined();
    const sb = structured<ManifestBundle>(sealed);
    expect(sb.manifest.artifacts).toHaveLength(20);
    expect(Object.keys(sb.blobs)).toHaveLength(0); // CAS, not inline
    const summary = JSON.parse(textOf(sealed)) as { artifacts: number; manifestDigest: string };
    expect(summary.artifacts).toBe(20);
    expect(summary.manifestDigest).toBe(sb.manifestDigest);
  });

  it("duplicate path across chunks → ERR_INVALID_PLAN; invalid artifact shape → ERR_INVALID_PLAN", async () => {
    const { sessionId } = structured<{ sessionId: string }>(
      await h.call("axiom_plan_begin", header),
    );
    await h.call("axiom_plan_add", {
      sessionId,
      artifacts: [{ path: "a.ts", source: { type: "inline", content: "1" } }],
    });
    const dup = await h.call("axiom_plan_add", {
      sessionId,
      artifacts: [{ path: "a.ts", source: { type: "inline", content: "2" } }],
    });
    expect(dup.isError).toBe(true);
    expect(structured<{ code: string; path?: string }>(dup)).toMatchObject({
      code: "ERR_INVALID_PLAN",
      path: "a.ts",
    });
    const bad = await h.call("axiom_plan_add", {
      sessionId,
      artifacts: [{ path: "../escape.ts", source: { type: "inline", content: "" } }],
    });
    expect(bad.isError).toBe(true);
    expect(structured<{ code: string }>(bad).code).toBe("ERR_INVALID_PLAN");
    // session still usable
    const ok = await h.call("axiom_plan_add", {
      sessionId,
      artifacts: [{ path: "b.ts", source: { type: "inline", content: "" } }],
    });
    expect(structured<{ artifacts: number }>(ok).artifacts).toBe(2);
  });

  it("unknown sessionId → ERR_TASK_NOT_FOUND; seal of an empty session → ERR_INVALID_PLAN (artifacts.min 1)", async () => {
    const r = await h.call("axiom_plan_add", {
      sessionId: "nope",
      artifacts: [{ path: "a.ts", source: { type: "inline", content: "" } }],
    });
    expect(r.isError).toBe(true);
    expect(structured<{ code: string }>(r).code).toBe("ERR_TASK_NOT_FOUND");

    const { sessionId } = structured<{ sessionId: string }>(
      await h.call("axiom_plan_begin", header),
    );
    const sealed = await h.call("axiom_plan_seal", { sessionId });
    expect(sealed.isError).toBe(true);
    expect(structured<{ code: string }>(sealed).code).toBe("ERR_INVALID_PLAN");
  });

  it("plan_begin validates the header (name pattern) up front", async () => {
    const r = await h.call("axiom_plan_begin", { name: "NOT VALID!!", intent: "x" });
    expect(r.isError).toBe(true);
    // header fields are the tool's input schema → SDK argument validation, like every other tool
    expect(textOf(r)).toMatch(/Invalid arguments/);
    expect(h.policy.roots.size).toBe(1);
  });

  it("session budget exceeded → ERR_PLAN_SESSION_STATE", async () => {
    const small = await harness([repo.root], {
      planSessions: new (await import("./tasks.js")).PlanSessionStore({ maxArtifacts: 1 }),
    });
    try {
      const { sessionId } = structured<{ sessionId: string }>(
        await small.call("axiom_plan_begin", header),
      );
      const r = await small.call("axiom_plan_add", {
        sessionId,
        artifacts: [
          { path: "a.ts", source: { type: "inline", content: "" } },
          { path: "b.ts", source: { type: "inline", content: "" } },
        ],
      });
      expect(r.isError).toBe(true);
      expect(structured<{ code: string }>(r).code).toBe("ERR_PLAN_SESSION_STATE");
    } finally {
      await small.close();
    }
  });
});

describe("factory sharing", () => {
  it("a task started on one server instance is pollable from another built by the same factory", async () => {
    const { serverFactory } = await import("./server.js");
    const { createRootsPolicy } = await import("./roots.js");
    const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
    const policy = await createRootsPolicy([repo.root]);
    const factory = serverFactory(policy, { tasks });
    const connect = async () => {
      const server = factory({ era: "legacy" } as never);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "0" });
      await Promise.all([server.connect(st), client.connect(ct)]);
      return {
        client,
        close: async () => {
          await client.close();
          await server.close();
        },
      };
    };
    const a = await connect();
    const b = await connect();
    try {
      const bundle = await compiled();
      const started = await a.client.callTool({
        name: "axiom_check_start",
        arguments: { bundle, root: repo.root },
      });
      const { taskId } = started.structuredContent as { taskId: string };
      for (;;) {
        const r = await b.client.callTool({ name: "axiom_task_get", arguments: { taskId } });
        const out = r.structuredContent as { status: string };
        if (out.status !== "working") {
          expect(out.status).toBe("completed");
          break;
        }
        await new Promise((res) => setTimeout(res, TASK_POLL_INTERVAL_MS / 100));
      }
    } finally {
      await a.close();
      await b.close();
    }
  });
});
