/**
 * `axiom attest decisions` (D-36, S-904): turn `.axiom/decisions.jsonl` (written by the gate when
 * the gate profile sets `record: true`) into in-toto agent-decision Statements, one per record,
 * optionally DSSE-signed with the repo's Ed25519 key. Output is JSON Lines, so a long journal
 * streams and each line verifies on its own.
 */
import {
  buildAgentDecisionStatement,
  DSSE_IN_TOTO_PAYLOAD_TYPE,
  type DsseEnvelope,
  type InTotoAgentDecisionV0_1,
  signEnvelope,
} from "@codai/axiom-canon";
import { type DecisionRecord, readDecisions } from "./decisions.js";
import { loadSigningKey, type SigningKeySource } from "./keys.js";

export interface AttestDecisionsOptions {
  root: string;
  since?: string;
  limit?: number;
  /** Present → every Statement is wrapped in a DSSE envelope signed with this key. */
  sign?: SigningKeySource;
}

export function statementFor(rec: DecisionRecord): InTotoAgentDecisionV0_1 {
  return buildAgentDecisionStatement({
    agent_id: rec.agent_id,
    principal: rec.principal,
    tool: rec.tool,
    args_hash: rec.args_hash,
    args_state: rec.args_state,
    // The v0.1 predicate knows allow|deny; an `ask` did not let the tool run unattended.
    decision: rec.decision === "allow" ? "allow" : "deny",
    ...(rec.code === undefined ? {} : { code: rec.code }),
    ...(rec.reason === undefined ? {} : { reason: rec.reason }),
    paths: rec.paths,
    profile: rec.profile,
    decided_at: rec.decided_at,
  });
}

export async function attestDecisions(
  opts: AttestDecisionsOptions,
): Promise<Array<InTotoAgentDecisionV0_1 | DsseEnvelope>> {
  let records = await readDecisions(
    opts.root,
    opts.since === undefined ? {} : { since: opts.since },
  );
  if (opts.limit !== undefined) records = records.slice(-opts.limit);
  const statements = records.map(statementFor);
  if (opts.sign === undefined) return statements;
  const key = await loadSigningKey(opts.sign);
  return statements.map((s) => signEnvelope(s, key, undefined, DSSE_IN_TOTO_PAYLOAD_TYPE));
}
