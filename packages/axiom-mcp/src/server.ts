
import http from "node:http";
import { parseAxiomSource } from "@axiom/core/dist/parser.js";
import { validateIR } from "@axiom/core/dist/validator.js";
import { AxiomIR } from "@axiom/core/dist/ir.js";
import { generate } from "@axiom/engine/dist/generate.js";
import { check } from "@axiom/engine/dist/check.js";
import { reverseIR } from "@axiom/engine/dist/reverse-ir.js";
import { diff, applyPatch } from "@axiom/engine/dist/axpatch.js";
import { apply } from "@axiom/engine/dist/apply.js";

const PORT = Number(process.env.AXIOM_MCP_PORT || 3411);

function send(res: http.ServerResponse, code: number, obj: any) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : {};
      if (req.method === "POST" && req.url === "/parse") {
        const { source } = input;
        const { ir, diagnostics } = parseAxiomSource(String(source ?? ""));
        return send(res, 200, { ir, diagnostics });
      }
      if (req.method === "POST" && req.url === "/validate") {
        const parse = AxiomIR.safeParse(input.ir);
        if (!parse.success) return send(res, 400, { ok: false, diagnostics: parse.error.issues });
        const result = validateIR(parse.data);
        return send(res, 200, result);
      }
      if (req.method === "POST" && req.url === "/generate") {
        const parse = AxiomIR.safeParse(input.ir);
        if (!parse.success) return send(res, 400, { error: parse.error.issues });
        const { artifacts, manifest } = await generate(parse.data, process.cwd(), input.profile);
        return send(res, 200, { artifacts, manifest });
      }
      if (req.method === "POST" && req.url === "/check") {
        const parse = input.ir ? AxiomIR.safeParse(input.ir) : null;
        const ir = parse?.success ? parse.data : undefined;
        const result = await check(input.manifest, ir, input.outRoot || process.cwd());
        return send(res, 200, result);
      }
      if (req.method === "POST" && req.url === "/reverse") {
        const result = await reverseIR({
          repoPath: input.repoPath || process.cwd(),
          outDir: input.outDir || "out",
        });
        return send(res, 200, result);
      }
      if (req.method === "POST" && req.url === "/diff") {
        const oldParse = AxiomIR.safeParse(input.oldIr);
        const newParse = AxiomIR.safeParse(input.newIr);
        if (!oldParse.success) return send(res, 400, { error: "Invalid oldIr", details: oldParse.error.issues });
        if (!newParse.success) return send(res, 400, { error: "Invalid newIr", details: newParse.error.issues });
        const patch = diff(oldParse.data, newParse.data);
        return send(res, 200, { patch });
      }
      if (req.method === "POST" && req.url === "/apply") {
        if (!input.manifest) return send(res, 400, { error: "Missing manifest" });
        const mode = input.mode || "fs";
        const result = await apply({
          manifest: input.manifest,
          mode: mode as "fs" | "pr",
          repoPath: input.repoPath || process.cwd(),
          branchName: input.branchName,
          commitMessage: input.commitMessage,
        });
        return send(res, 200, result);
      }
      send(res, 404, { error: "Not found" });
    });
  } catch (e: any) {
    send(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`[axiom-mcp] listening on http://localhost:${PORT}`);
});
