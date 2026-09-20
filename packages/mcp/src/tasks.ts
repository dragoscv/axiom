/**
 * S-406 / D-24 — tool-level tasks and chunked plan sessions.
 *
 * MCP SDK v2 ships the `io.modelcontextprotocol/tasks` wire vocabulary but no runtime (the
 * `tasks/*` methods are excluded from `setRequestHandler`, and the 2026-07-28 `tools/call` codec
 * rejects a `CreateTaskResult`). AXIOM therefore models long-running work as ordinary tools:
 * `axiom_check_start` → `{ taskId, status: "working", pollIntervalMs, ttlMs }`, then
 * `axiom_task_get` until `status` is terminal, `axiom_task_cancel` to abort. This works on every
 * client that can call a tool (Copilot, codai agent-core, SDK v1 and v2) and on both wire eras.
 *
 * State is per factory (shared by every server instance a `serverFactory` builds, like
 * `seenRoots`), never persisted: a restarted server has no tasks, and a poll for an unknown id is
 * `ERR_TASK_NOT_FOUND`. Terminal tasks are kept for `ttlMs` after finishing, then dropped.
 *
 * The same store hosts chunked plan sessions (`axiom_plan_begin` → `axiom_plan_add`* →
 * `axiom_plan_seal`): artifacts accumulate server-side so a Plan whose JSON would exceed the
 * per-call 4 MiB payload cap can still be compiled. Sealing feeds the assembled Plan to the very
 * same `compilePlan`, so the digest is identical to a one-shot compile (property test).
 */
import { randomUUID } from "node:crypto";
import { AxiomError, type PlanArtifact, type PlanInput } from "@codai/axiom-schema";
import { z } from "zod";

export const TASK_STATUSES = ["working", "completed", "failed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** How long a finished task stays pollable. */
export const TASK_TTL_MS = 10 * 60_000;
/** Advisory poll interval returned to clients. */
export const TASK_POLL_INTERVAL_MS = 2_000;
/** Concurrent `working` tasks per server process; the (n+1)th `axiom_check_start` is refused. */
export const TASK_MAX_WORKING = 8;
/** Open (unsealed) plan sessions per process. */
export const PLAN_SESSION_MAX_OPEN = 16;
/** Idle sessions (no `add`/`seal`) are dropped after this. */
export const PLAN_SESSION_TTL_MS = 30 * 60_000;
/** Artifacts a session may hold — same bound as `PlanSchema.artifacts.max`. */
export const PLAN_SESSION_MAX_ARTIFACTS = 2000;
/** Summed UTF-8 JSON bytes of every chunk a session accepts (64 MiB, the `default` profile's `maxTotalBytes`). */
export const PLAN_SESSION_MAX_BYTES = 64 * 1024 * 1024;

export const TaskStatusSchema = z.enum(TASK_STATUSES);

export const TaskErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export interface TaskRecord<T = unknown> {
  taskId: string;
  /** Tool that created the task (`axiom_check`). */
  tool: string;
  status: TaskStatus;
  createdAt: number;
  /** Set when the task reaches a terminal status. */
  finishedAt?: number;
  result?: T;
  error?: z.output<typeof TaskErrorSchema>;
  controller: AbortController;
  /** Root the task was bound to (for logging / listing). */
  root?: string;
}

export interface TaskDescriptor {
  taskId: string;
  tool: string;
  status: TaskStatus;
  pollIntervalMs: number;
  ttlMs: number;
  /** Milliseconds since the task was created. */
  elapsedMs: number;
}

export interface TaskStoreOptions {
  now?: () => number;
  ttlMs?: number;
  pollIntervalMs?: number;
  maxWorking?: number;
}

export class TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly now: () => number;
  readonly ttlMs: number;
  readonly pollIntervalMs: number;
  readonly maxWorking: number;

  constructor(opts: TaskStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? TASK_TTL_MS;
    this.pollIntervalMs = opts.pollIntervalMs ?? TASK_POLL_INTERVAL_MS;
    this.maxWorking = opts.maxWorking ?? TASK_MAX_WORKING;
  }

  /**
   * Start `work` in the background. The returned record is `working` until the promise settles;
   * a rejection becomes `failed` (AxiomError → its closed code, anything else → `ERR_INTERNAL`),
   * a rejection after `cancel()` stays `cancelled`.
   */
  start<T>(
    tool: string,
    work: (signal: AbortSignal) => Promise<T>,
    meta: { root?: string } = {},
  ): TaskRecord<T> {
    this.sweep();
    const working = [...this.tasks.values()].filter((t) => t.status === "working").length;
    if (working >= this.maxWorking) {
      throw new AxiomError("ERR_EBUSY", `too many running tasks (${working}/${this.maxWorking})`, {
        details: { working, max: this.maxWorking },
      });
    }
    const controller = new AbortController();
    const rec: TaskRecord<T> = {
      taskId: randomUUID(),
      tool,
      status: "working",
      createdAt: this.now(),
      controller,
    };
    if (meta.root !== undefined) rec.root = meta.root;
    this.tasks.set(rec.taskId, rec as TaskRecord);
    work(controller.signal).then(
      (result) => {
        if (rec.status !== "working") return;
        rec.status = "completed";
        rec.result = result;
        rec.finishedAt = this.now();
      },
      (err: unknown) => {
        if (rec.status !== "working") return;
        rec.status = controller.signal.aborted ? "cancelled" : "failed";
        rec.error = toTaskError(err);
        rec.finishedAt = this.now();
      },
    );
    return rec;
  }

  get(taskId: string): TaskRecord {
    this.sweep();
    const rec = this.tasks.get(taskId);
    if (rec === undefined) {
      throw new AxiomError("ERR_TASK_NOT_FOUND", `no task ${taskId}`, { details: { taskId } });
    }
    return rec;
  }

  /** Abort a `working` task; terminal tasks are left as they are (idempotent). */
  cancel(taskId: string): TaskRecord {
    const rec = this.get(taskId);
    if (rec.status === "working") {
      rec.status = "cancelled";
      rec.finishedAt = this.now();
      rec.error = { code: "ERR_TASK_CANCELLED", message: "cancelled via axiom_task_cancel" };
      rec.controller.abort();
    }
    return rec;
  }

  describe(rec: TaskRecord): TaskDescriptor {
    return {
      taskId: rec.taskId,
      tool: rec.tool,
      status: rec.status,
      pollIntervalMs: this.pollIntervalMs,
      ttlMs: this.ttlMs,
      elapsedMs: Math.max(0, (rec.finishedAt ?? this.now()) - rec.createdAt),
    };
  }

  /** Drop terminal tasks older than `ttlMs`. */
  sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, t] of this.tasks) {
      if (t.finishedAt !== undefined && t.finishedAt < cutoff) this.tasks.delete(id);
    }
  }

  /** Abort everything still running (server shutdown). */
  abortAll(): void {
    for (const t of this.tasks.values()) if (t.status === "working") this.cancel(t.taskId);
  }

  get size(): number {
    return this.tasks.size;
  }
}

export function toTaskError(err: unknown): z.output<typeof TaskErrorSchema> {
  if (err instanceof AxiomError) {
    const j = err.toJSON();
    const out: z.output<typeof TaskErrorSchema> = { code: j.code, message: j.message };
    if (j.details !== undefined) out.details = j.details;
    return out;
  }
  return { code: "ERR_INTERNAL", message: err instanceof Error ? err.message : String(err) };
}

// --- chunked plan sessions ---------------------------------------------------------------------

/** Everything in a Plan except `artifacts` (and the fixed `apiVersion`/`kind`) — what `axiom_plan_begin` receives. */
export type PlanHeader = Omit<PlanInput, "artifacts" | "apiVersion" | "kind">;

export interface PlanSession {
  sessionId: string;
  header: PlanHeader;
  artifacts: PlanArtifact[];
  paths: Set<string>;
  /** Summed UTF-8 JSON bytes of accepted chunks. */
  bytes: number;
  createdAt: number;
  touchedAt: number;
  sealed: boolean;
}

export interface PlanSessionStoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxOpen?: number;
  maxArtifacts?: number;
  maxBytes?: number;
}

export class PlanSessionStore {
  private readonly sessions = new Map<string, PlanSession>();
  private readonly now: () => number;
  readonly ttlMs: number;
  readonly maxOpen: number;
  readonly maxArtifacts: number;
  readonly maxBytes: number;

  constructor(opts: PlanSessionStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? PLAN_SESSION_TTL_MS;
    this.maxOpen = opts.maxOpen ?? PLAN_SESSION_MAX_OPEN;
    this.maxArtifacts = opts.maxArtifacts ?? PLAN_SESSION_MAX_ARTIFACTS;
    this.maxBytes = opts.maxBytes ?? PLAN_SESSION_MAX_BYTES;
  }

  begin(header: PlanHeader): PlanSession {
    this.sweep();
    if (this.sessions.size >= this.maxOpen) {
      throw new AxiomError(
        "ERR_EBUSY",
        `too many open plan sessions (${this.sessions.size}/${this.maxOpen})`,
        { details: { open: this.sessions.size, max: this.maxOpen } },
      );
    }
    const t = this.now();
    const s: PlanSession = {
      sessionId: randomUUID(),
      header,
      artifacts: [],
      paths: new Set(),
      bytes: 0,
      createdAt: t,
      touchedAt: t,
      sealed: false,
    };
    this.sessions.set(s.sessionId, s);
    return s;
  }

  get(sessionId: string): PlanSession {
    this.sweep();
    const s = this.sessions.get(sessionId);
    if (s === undefined) {
      throw new AxiomError("ERR_TASK_NOT_FOUND", `no plan session ${sessionId}`, {
        details: { sessionId },
      });
    }
    return s;
  }

  /** Append already-validated artifacts; duplicates (within or across chunks) are `ERR_INVALID_PLAN`. */
  add(sessionId: string, artifacts: readonly PlanArtifact[], chunkBytes: number): PlanSession {
    const s = this.get(sessionId);
    if (s.sealed) {
      throw new AxiomError("ERR_PLAN_SESSION_STATE", "plan session is already sealed", {
        details: { sessionId },
      });
    }
    if (s.artifacts.length + artifacts.length > this.maxArtifacts) {
      throw new AxiomError(
        "ERR_PLAN_SESSION_STATE",
        `session would hold ${s.artifacts.length + artifacts.length} artifacts; max ${this.maxArtifacts}`,
        { details: { sessionId, have: s.artifacts.length, adding: artifacts.length } },
      );
    }
    if (s.bytes + chunkBytes > this.maxBytes) {
      throw new AxiomError(
        "ERR_PLAN_SESSION_STATE",
        `session would hold ${s.bytes + chunkBytes} bytes; max ${this.maxBytes}`,
        { details: { sessionId, have: s.bytes, adding: chunkBytes, max: this.maxBytes } },
      );
    }
    for (const a of artifacts) {
      if (s.paths.has(a.path)) {
        throw new AxiomError("ERR_INVALID_PLAN", "duplicate artifact path across chunks", {
          path: a.path,
          details: { sessionId },
        });
      }
    }
    for (const a of artifacts) {
      s.paths.add(a.path);
      s.artifacts.push(a);
    }
    s.bytes += chunkBytes;
    s.touchedAt = this.now();
    return s;
  }

  /** Mark sealed and return the assembled Plan input; the session is dropped. */
  seal(sessionId: string): { session: PlanSession; plan: PlanInput } {
    const s = this.get(sessionId);
    if (s.sealed) {
      throw new AxiomError("ERR_PLAN_SESSION_STATE", "plan session is already sealed", {
        details: { sessionId },
      });
    }
    s.sealed = true;
    this.sessions.delete(sessionId);
    const plan: PlanInput = {
      apiVersion: "axiom.dev/v2",
      kind: "Plan",
      ...s.header,
      artifacts: s.artifacts,
    };
    return { session: s, plan };
  }

  /** Drop an unsealed session without compiling. Unknown ids are a no-op. */
  abandon(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, s] of this.sessions) if (s.touchedAt < cutoff) this.sessions.delete(id);
  }

  get size(): number {
    return this.sessions.size;
  }
}
