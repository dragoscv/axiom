
import { z } from "zod";

export const Capability = z.object({
  kind: z.enum(["fs","net","secret","ai","compute"]),
  args: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  optional: z.boolean().optional()
});

export const Constraint = z.object({
  lhs: z.string(),
  op: z.enum(["==","!=", "<=" ,">=","<",">"]),
  rhs: z.union([z.string(), z.number(), z.boolean()])
});

export const Check = z.object({
  kind: z.enum(["unit","policy","sla"]),
  name: z.string(),
  expect: z.string()
});

export const EmitItem = z.object({
  type: z.enum(["service","tests","report","manifest"]),
  subtype: z.string().optional(),
  target: z.string()
});

export const AgentIR = z.object({
  name: z.string(),
  intent: z.string(),
  constraints: z.array(Constraint).default([]),
  capabilities: z.array(Capability).default([]),
  checks: z.array(Check).default([]),
  emit: z.array(EmitItem)
});

export const AxiomIR = z.object({
  version: z.literal("1.0.0"),
  agents: z.array(AgentIR).min(1)
});

export type TAxiomIR = z.infer<typeof AxiomIR>;
export type TAgentIR = z.infer<typeof AgentIR>;
