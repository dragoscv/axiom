/**
 * MC-7: a confirmation round must be SINGLE USE. The token was otherwise stateless (an HMAC over a
 * binding, a mint time and a nonce, verified in the same process), so the same `requestState` plus
 * answer could authorise a SECOND destructive apply inside the 15-minute window — the audit
 * re-applied a change after a rollback without anyone being asked again.
 */
import { describe, expect, it } from "vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  ELICIT_CONFIRM_KEY,
  ElicitPending,
  elicitConfirm,
} from "./adapter.js";

const BINDING = "apply|sha256:deadbeef";

/** A minimal `ServerContext`: the form capability, a requestState and the input responses. */
function ctxWith(state: unknown, confirm = true) {
  return {
    mcpReq: {
      envelope: {
        [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
      },
      inputResponses: {
        [ELICIT_CONFIRM_KEY]: {
          kind: "elicit",
          action: "accept",
          content: { confirm, digest12: "abcdef012345" },
        },
      },
      requestState: () => state,
    },
  };
}

/** The server is only consulted for capabilities when the envelope lacks them. */
const server = {
  server: { getClientCapabilities: () => ({ elicitation: { form: {} } }) },
} as never;
const req = {
  message: "apply sha256:deadbeef?",
  requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } } },
  binding: BINDING,
};

/** Mint a round by asking once, then take the token it handed the client. */
async function mintRound(): Promise<string> {
  const pending = (await elicitConfirm(server, ctxWith(undefined), req).then(
    () => undefined,
    (e: unknown) => e,
  )) as ElicitPending;
  expect(pending).toBeInstanceOf(ElicitPending);
  const state = (pending.result as { requestState?: unknown }).requestState;
  expect(typeof state).toBe("string");
  return state as string;
}

describe("elicitConfirm is single use (MC-7)", () => {
  it("accepts an answer once, then asks again instead of authorising a replay", async () => {
    const state = await mintRound();

    const first = await elicitConfirm(server, ctxWith(state), req);
    expect(first).toMatchObject({ action: "accept" });
    expect(first.content).toMatchObject({ confirm: true });

    // The same round replayed: it must NOT be accepted a second time.
    const second = await elicitConfirm(server, ctxWith(state), req).then(
      (r) => ({ resolved: r }),
      (e: unknown) => ({ threw: e as Error }),
    );
    expect(second).toHaveProperty("threw");
    const threw = (second as { threw: ElicitPending }).threw;
    expect(threw).toBeInstanceOf(ElicitPending);
    // The fresh round carries a NEW token, so the client is asked in a new round.
    const next = (threw.result as { requestState?: unknown }).requestState;
    expect(next).not.toBe(state);
  });

  it("a token minted for another binding is refused", async () => {
    const state = await mintRound();
    const other = { ...req, binding: "apply|sha256:00000000" };
    const r = await elicitConfirm(server, ctxWith(state), other).then(
      (x) => ({ resolved: x }),
      (e: unknown) => ({ threw: e as Error }),
    );
    expect(r).toHaveProperty("threw");
    expect((r as { threw: Error }).threw).toBeInstanceOf(ElicitPending);
  });

  it("a forged token is refused", async () => {
    const state = await mintRound();
    const forged = `${state.split(".").slice(0, 3).join(".")}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const r = await elicitConfirm(server, ctxWith(forged), req).then(
      (x) => ({ resolved: x }),
      (e: unknown) => ({ threw: e as Error }),
    );
    expect(r).toHaveProperty("threw");
    expect((r as { threw: Error }).threw).toBeInstanceOf(ElicitPending);
  });

  it("a declined answer is not an error", async () => {
    const state = await mintRound();
    const ctx = ctxWith(state);
    (ctx.mcpReq.inputResponses[ELICIT_CONFIRM_KEY] as { action: string }).action = "decline";
    const r = await elicitConfirm(server, ctx, req);
    expect(r.action).toBe("decline");
  });
});
