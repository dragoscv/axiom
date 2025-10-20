
import type { TAxiomIR, TAgentIR } from "@codai/axiom-core/dist/ir.js";

export interface EmitterContext {
  ir: TAxiomIR;
  agent: TAgentIR;
  target: string;
  profile?: string;
  write(filePath: string, content: string): void;
}

export interface Emitter {
  subtype: string;
  generate(ctx: EmitterContext): Promise<void>;
}
