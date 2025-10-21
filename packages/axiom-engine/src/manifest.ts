
export interface Artifact {
  path: string;
  kind: "file" | "report";
  sha256: string;
  bytes: number;
  // Optional embedded content (fallback if store unavailable)
  contentUtf8?: string;
  contentBase64?: string;
}

export interface Evidence {
  checkName: string;
  kind: "unit" | "policy" | "sla";
  passed: boolean;
  details?: unknown;
}

export interface Manifest {
  version: "1.0.0";
  buildId: string;
  irHash: string;
  profile?: string;
  artifacts: Artifact[];
  evidence: Evidence[];
  createdAt: string;
}
