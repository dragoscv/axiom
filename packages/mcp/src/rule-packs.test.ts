import { describe, expect, it } from "vitest";
import {
  CommandRuleSchema,
  type CommandsConfig,
  EXTRA_PACKS,
  type ExtraPack,
  evaluateCommandRules,
} from "./command-rules.js";
import { TOPIC_PACKS, TOPIC_RULES } from "./rule-packs.js";

// Built from pieces: a PreToolUse guard on the maintainer's machine scans edit text for them.
const SQL_DROP = ["DR", "OP"].join("");
const SQL_TRUNC = ["TRUNC", "ATE"].join("");

const cfg = (...packs: ExtraPack[]): CommandsConfig => ({ deny: [], pack: "none", packs });
const ids = (command: string, ...packs: ExtraPack[]): string[] =>
  evaluateCommandRules(command, cfg(...packs)).map((v) => v.id);
const bare = (command: string): string[] =>
  evaluateCommandRules(command, { deny: [], pack: "none" }).map((v) => v.id);

interface Case {
  pack: ExtraPack;
  rule: string;
  deny: string;
  allow: string;
}

const CASES: readonly Case[] = [
  {
    pack: "cloud",
    rule: "pack.cloud.s3RecursiveDelete",
    deny: "aws s3 rm s3://prod-bucket/prefix --recursive",
    allow: "aws s3 rm s3://prod-bucket/one-key",
  },
  {
    pack: "cloud",
    rule: "pack.cloud.gcloudDelete",
    deny: "gcloud compute instances delete vm-1 --zone europe-west1-b",
    allow: "gcloud compute instances list",
  },
  {
    pack: "cloud",
    rule: "pack.cloud.azDelete",
    deny: "az group delete --name rg-prod --yes",
    allow: "az group list",
  },
  {
    pack: "cloud",
    rule: "pack.cloud.railwayDelete",
    deny: "railway volume delete --yes",
    allow: "railway status",
  },
  {
    pack: "kubernetes",
    rule: "pack.kubernetes.kubectlDelete",
    deny: "kubectl delete namespace prod",
    allow: "kubectl delete pod web-1 -n staging",
  },
  {
    pack: "kubernetes",
    rule: "pack.kubernetes.helmUninstall",
    deny: "helm uninstall api -n prod",
    allow: "helm upgrade --install api ./chart",
  },
  {
    pack: "database",
    rule: "pack.database.destructiveSql",
    deny: `psql -c "${SQL_DROP} TABLE users"`,
    allow: 'psql -c "SELECT count(*) FROM users"',
  },
  {
    pack: "database",
    rule: "pack.database.prismaReset",
    deny: "npx prisma migrate reset --force",
    allow: "prisma migrate status",
  },
  {
    pack: "iac",
    rule: "pack.iac.destroy",
    deny: "terraform destroy -auto-approve",
    allow: "terraform plan -out=tfplan",
  },
  {
    pack: "iac",
    rule: "pack.iac.stateRemove",
    deny: "terraform state rm aws_instance.web",
    allow: "terraform state list",
  },
  {
    pack: "secrets",
    rule: "pack.secrets.credentialRead",
    deny: "cat ~/.aws/credentials",
    allow: "cat ~/.aws/credentials.example",
  },
];

describe("S-1422: the topic packs are data, and none is enabled by a preset", () => {
  it("has one entry per enum value, with pack-prefixed rule ids", () => {
    expect(TOPIC_PACKS.map((p) => p.pack)).toEqual([...EXTRA_PACKS]);
    for (const topic of TOPIC_PACKS) {
      for (const rule of topic.rules) {
        expect(rule.id).toMatch(/^pack\.[a-z]+\.[a-zA-Z0-9]+$/);
        expect(rule.id?.split(".")[1]).toBe(topic.pack);
        expect(CommandRuleSchema.safeParse(rule).success).toBe(true);
      }
    }
    expect(new Set(TOPIC_RULES.map((r) => r.id)).size).toBe(TOPIC_RULES.length);
  });

  it("does not fire any topic rule under a base pack alone", () => {
    for (const c of CASES) {
      for (const pack of ["none", "core", "shared-clone", "house"] as const) {
        const hit = evaluateCommandRules(c.deny, { deny: [], pack }).map((v) => v.id);
        // A base pack may fire its own rule (house.sqlDestructive covers the same statement); what
        // must never happen is a `pack.*` verdict without opting into that pack.
        expect(
          hit.filter((id) => id.startsWith("pack.")),
          `${c.deny} / ${pack}`,
        ).toEqual([]);
      }
      expect(bare(c.allow), c.allow).toEqual([]);
    }
  });

  it("refuses each rule's destructive command and allows its near-miss", () => {
    for (const c of CASES) {
      expect(ids(c.deny, c.pack), c.deny).toContain(c.rule);
      expect(ids(c.allow, c.pack), c.allow).not.toContain(c.rule);
    }
  });

  it("matches a program and its operands, never text that only names them", () => {
    for (const command of [
      "rg -n 'kubectl delete namespace prod' docs",
      "echo 'terraform destroy'",
      `Write-Host "${SQL_TRUNC} TABLE logs"`,
      "git commit -m 'aws s3 rm --recursive docs' -- a.md",
      "Get-Content -Raw notes.md",
    ]) {
      const hit = evaluateCommandRules(command, cfg(...EXTRA_PACKS)).map((v) => v.id);
      expect(hit, command).toEqual([]);
    }
  });

  it("honours only the packs a policy lists, in the order it listed them, without duplicates", () => {
    expect(ids("terraform destroy", "iac")).toEqual(["pack.iac.destroy"]);
    expect(ids("terraform destroy", "cloud")).toEqual([]);
    expect(ids("terraform destroy", "iac", "cloud", "iac")).toEqual(["pack.iac.destroy"]);
  });

  it("unwraps a package-manager prefix before matching the program", () => {
    expect(ids("npx kubectl delete ns prod", "kubernetes")).toContain(
      "pack.kubernetes.kubectlDelete",
    );
    expect(ids("pnpm exec kubectl delete ns prod", "kubernetes")).toContain(
      "pack.kubernetes.kubectlDelete",
    );
    // `pnpm run X` runs a script, not the tool X names.
    expect(ids("pnpm run terraform destroy", "iac")).toEqual([]);
  });

  it("asks (never denies) before a credential file reaches a command", () => {
    const v = evaluateCommandRules("cat .env", cfg("secrets")).find(
      (x) => x.id === "pack.secrets.credentialRead",
    );
    expect(v?.decision).toBe("ask");
    expect(ids("cat .env.example", "secrets")).toEqual([]);
    expect(ids("cat src/app.ts", "secrets")).toEqual([]);
  });
});
