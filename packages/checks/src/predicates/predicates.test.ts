import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChecks } from "../run.js";
import { makeBundle, profileWith } from "../test-helpers.test-helpers.js";
import { SECRET_PATTERNS } from "./content.js";

const one = (predicate: string, params: unknown, severity: "error" | "warn" | "info" = "error") =>
  profileWith([{ id: predicate, predicate, params: params as never, severity }]);

async function ids(
  bundle: ReturnType<typeof makeBundle>,
  predicate: string,
  params: unknown,
  root?: string,
) {
  const opts: Parameters<typeof runChecks>[0] = { bundle, profile: one(predicate, params) };
  if (root !== undefined) opts.root = root;
  const r = await runChecks(opts);
  return { verdict: r.verdict, ids: r.findings.map((f) => f.id), findings: r.findings };
}

describe("path.*", () => {
  const b = makeBundle([
    { path: "src/a.ts", content: "a" },
    { path: "docs/b.md", content: "b" },
  ]);
  it("allow: passes when all match, fails otherwise", async () => {
    expect((await ids(b, "path.allow", { globs: ["src/**", "docs/**"] })).verdict).toBe("pass");
    const r = await ids(b, "path.allow", { globs: ["src/**"] });
    expect(r.verdict).toBe("fail");
    expect(r.findings[0]?.path).toBe("docs/b.md");
  });
  it("deny: fails on match, passes otherwise", async () => {
    expect((await ids(b, "path.deny", { globs: ["**/*.md"] })).verdict).toBe("fail");
    expect((await ids(b, "path.deny", { globs: ["**/*.py"] })).verdict).toBe("pass");
  });
  it("reservedNames: passes on schema-valid paths", async () => {
    expect((await ids(b, "path.reservedNames", {})).verdict).toBe("pass");
  });
  it("reservedNames: catches a reserved name smuggled past the schema", async () => {
    const bad = makeBundle([{ path: "ok.txt", content: "x" }]);
    bad.manifest.artifacts[0] = { ...bad.manifest.artifacts[0]!, path: "CON.txt" };
    const r = await ids(bad, "path.reservedNames", {});
    expect(r.verdict).toBe("fail");
    expect(r.findings[0]?.facts.issues).toContain("ERR_PATH_RESERVED_NAME");
  });
});

describe("content.noSecrets", () => {
  const samples: Record<string, string> = {
    cnp: "cnp 1960101123456 here",
    email: "contact me at john.doe@example.com",
    phoneRo: "call 0722123456",
    card: "card 4111 1111 1111 1111",
    credentialAssignment: 'password = "hunter22"',
    awsKey: "AKIAIOSFODNN7EXAMPLE",
    githubToken: `ghp_${"a".repeat(36)}`,
    privateKey: "-----BEGIN RSA PRIVATE KEY-----",
    jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_-123",
    slackToken: "xoxb-1234",
  };
  it("has a sample for every pattern", () => {
    expect(Object.keys(samples).sort()).toEqual(SECRET_PATTERNS.map((p) => p.name).sort());
  });
  for (const [name, text] of Object.entries(samples)) {
    it(`catches ${name}`, async () => {
      const b = makeBundle([{ path: "x.txt", content: text }]);
      const r = await ids(b, "content.noSecrets", {});
      expect(r.verdict).toBe("fail");
      expect(r.ids).toContain(`content.noSecrets.${name}`);
    });
  }
  it("passes clean content", async () => {
    const b = makeBundle([{ path: "x.txt", content: "export const a = 1;\n" }]);
    expect((await ids(b, "content.noSecrets", {})).verdict).toBe("pass");
  });
  it("respects disable", async () => {
    const b = makeBundle([{ path: "x.txt", content: samples.awsKey! }]);
    expect((await ids(b, "content.noSecrets", { disable: ["awsKey"] })).verdict).toBe("pass");
  });
  it("respects allowPaths", async () => {
    const b = makeBundle([{ path: "fixtures/x.txt", content: samples.awsKey! }]);
    expect((await ids(b, "content.noSecrets", { allowPaths: ["fixtures/**"] })).verdict).toBe(
      "pass",
    );
  });
  it("skips deletes and artifacts without content", async () => {
    const b = makeBundle([
      { path: "d.txt", op: "delete" },
      { path: "n.txt", content: samples.awsKey!, noBlob: true },
    ]);
    expect((await ids(b, "content.noSecrets", {})).verdict).toBe("pass");
  });
});

describe("content.maxBytes / encodingUtf8", () => {
  it("maxBytes fails only over the limit and honours globs", async () => {
    const b = makeBundle([
      { path: "a.bin", content: "12345" },
      { path: "b.txt", content: "1" },
    ]);
    expect((await ids(b, "content.maxBytes", { max: 5 })).verdict).toBe("pass");
    const r = await ids(b, "content.maxBytes", { max: 4 });
    expect(r.verdict).toBe("fail");
    expect(r.findings.map((f) => f.path)).toEqual(["a.bin"]);
    expect((await ids(b, "content.maxBytes", { max: 4, globs: ["*.txt"] })).verdict).toBe("pass");
  });
  it("encodingUtf8 fails on invalid bytes", async () => {
    const b = makeBundle([{ path: "bad.txt", content: new Uint8Array([0xff, 0xfe, 0x41]) }]);
    expect((await ids(b, "content.encodingUtf8", {})).verdict).toBe("fail");
    const ok = makeBundle([{ path: "ok.txt", content: "héllo" }]);
    expect((await ids(ok, "content.encodingUtf8", {})).verdict).toBe("pass");
  });
});

describe("manifest.*", () => {
  const b = makeBundle([
    { path: "a", content: "aa" },
    { path: "b", op: "delete" },
  ]);
  it("maxArtifacts", async () => {
    expect((await ids(b, "manifest.maxArtifacts", { max: 2 })).verdict).toBe("pass");
    expect((await ids(b, "manifest.maxArtifacts", { max: 1 })).verdict).toBe("fail");
  });
  it("maxTotalBytes", async () => {
    expect((await ids(b, "manifest.maxTotalBytes", { max: 2 })).verdict).toBe("pass");
    expect((await ids(b, "manifest.maxTotalBytes", { max: 1 })).verdict).toBe("fail");
  });
  it("noDeletes", async () => {
    expect((await ids(b, "manifest.noDeletes", {})).verdict).toBe("fail");
    const clean = makeBundle([{ path: "a", content: "x" }]);
    expect((await ids(clean, "manifest.noDeletes", {})).verdict).toBe("pass");
  });
  it("requireSigned without a root is an error (fail closed), never a pass", async () => {
    const r = await ids(b, "manifest.requireSigned", {});
    expect(r.verdict).toBe("error");
    expect(r.findings[0]?.facts.code).toBe("ERR_PROVIDER_FAILED");
  });
});

describe("deps.*", () => {
  const pkg = JSON.stringify({
    dependencies: { a: "1", b: "1" },
    devDependencies: { left_pad: "1" },
  });
  const b = makeBundle([
    { path: "package.json", content: pkg },
    { path: "readme.md", content: "not json" },
  ]);
  it("max counts deps + devDeps", async () => {
    expect((await ids(b, "deps.max", { max: 3 })).verdict).toBe("pass");
    const r = await ids(b, "deps.max", { max: 2 });
    expect(r.verdict).toBe("fail");
    expect(r.findings[0]?.facts.count).toBe(3);
  });
  it("max ignores files outside `files`", async () => {
    expect((await ids(b, "deps.max", { max: 0, files: ["apps/**/package.json"] })).verdict).toBe(
      "pass",
    );
  });
  it("deny", async () => {
    const r = await ids(b, "deps.deny", { packages: ["left_pad"] });
    expect(r.verdict).toBe("fail");
    expect(r.ids).toEqual(["deps.deny.left_pad"]);
    expect((await ids(b, "deps.deny", { packages: ["nope"] })).verdict).toBe("pass");
  });
});

describe("repo.*", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "axiom-checks-"));
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    await mkdir(join(root, "packages", "sdk", "src"), { recursive: true });
    await writeFile(join(root, "packages", "sdk", "src", "client.ts"), "export {};\n");
    await writeFile(join(root, ".gitignore"), "ignored-dir/\n");
    await mkdir(join(root, "ignored-dir"), { recursive: true });
    await writeFile(join(root, "ignored-dir", "secret.ts"), "");
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("noOverwriteOf fails only when the protected file exists", async () => {
    const globs = ["**/*.yaml", ".env*"];
    const existing = makeBundle([{ path: "pnpm-lock.yaml", op: "overwrite", content: "x" }]);
    expect((await ids(existing, "repo.noOverwriteOf", { globs }, root)).verdict).toBe("fail");
    const missing = makeBundle([{ path: ".env.local", op: "overwrite", content: "x" }]);
    expect((await ids(missing, "repo.noOverwriteOf", { globs }, root)).verdict).toBe("pass");
    const create = makeBundle([{ path: "pnpm-lock.yaml", op: "create", content: "x" }]);
    expect((await ids(create, "repo.noOverwriteOf", { globs }, root)).verdict).toBe("pass");
  });
  it("noOverwriteOf is skipped without a root", async () => {
    const b = makeBundle([{ path: "pnpm-lock.yaml", op: "overwrite", content: "x" }]);
    const r = await runChecks({ bundle: b, profile: one("repo.noOverwriteOf", { globs: ["**"] }) });
    expect(r.verdict).toBe("pass");
    expect(r.providers.find((p) => p.name === "repo")?.status).toBe("skipped");
  });

  const rules = {
    rules: [
      { when: "apps/web/src/actions/**", expect: [{ name: "sdk", match: "packages/sdk/src/**" }] },
    ],
  };
  it("requireCompanion satisfied by an artifact", async () => {
    const b = makeBundle([
      { path: "apps/web/src/actions/x.ts", content: "" },
      { path: "packages/sdk/src/x.ts", content: "" },
    ]);
    expect((await ids(b, "repo.requireCompanion", rules, root)).verdict).toBe("pass");
  });
  it("requireCompanion satisfied by a repo file", async () => {
    const b = makeBundle([{ path: "apps/web/src/actions/x.ts", content: "" }]);
    expect((await ids(b, "repo.requireCompanion", rules, root)).verdict).toBe("pass");
  });
  it("requireCompanion fails when neither present, passes when not triggered", async () => {
    const b = makeBundle([{ path: "apps/web/src/actions/x.ts", content: "" }]);
    const r = await ids(
      b,
      "repo.requireCompanion",
      { rules: [{ when: "apps/web/**", expect: [{ name: "php", match: "packages/sdk-php/**" }] }] },
      root,
    );
    expect(r.verdict).toBe("fail");
    expect(r.ids).toEqual(["repo.requireCompanion.php"]);
    const untriggered = makeBundle([{ path: "docs/a.md", content: "" }]);
    expect((await ids(untriggered, "repo.requireCompanion", rules, root)).verdict).toBe("pass");
  });
  it("repo glob respects .gitignore", async () => {
    const b = makeBundle([{ path: "apps/web/x.ts", content: "" }]);
    const r = await ids(
      b,
      "repo.requireCompanion",
      { rules: [{ when: "apps/**", expect: [{ name: "i", match: "ignored-dir/**" }] }] },
      root,
    );
    expect(r.verdict).toBe("fail");
  });
});

describe("guard.external", () => {
  const b = makeBundle([{ path: "a", content: "x" }]);
  it("errors when the server did not pass --allow-guards", async () => {
    const r = await runChecks({
      bundle: b,
      profile: profileWith(
        [
          {
            id: "g",
            predicate: "guard.external",
            params: { command: "scripts/x.mjs" } as never,
            severity: "error",
          },
        ],
        { allowGuards: true },
      ),
    });
    expect(r.verdict).toBe("error");
    expect(r.findings[0]?.facts.code).toBe("ERR_UNSUPPORTED_OP");
    expect(r.findings[0]?.message).toMatch(/disabled/);
  });
  it("errors when the profile forbids guards", async () => {
    const r = await ids(b, "guard.external", { command: "x" });
    expect(r.verdict).toBe("error");
  });
});
