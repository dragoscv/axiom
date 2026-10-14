#!/usr/bin/env node
// Not shipped. Times `axiom-hook --version` and a full daemon round-trip against a mock daemon.
//   cargo build --release && node bench/bench.mjs [runs=30]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runs = Number(process.argv[2] ?? 30);
const exe = fileURLToPath(
  new URL(`../target/release/axiom-hook${process.platform === "win32" ? ".exe" : ""}`, import.meta.url),
);

const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "x-axiom-exit": "0", "x-axiom-stderr": "", "content-length": "0" });
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const home = mkdtempSync(join(tmpdir(), "axiom-hook-bench-"));
mkdirSync(join(home, ".axiom"));
writeFileSync(
  join(home, ".axiom", "daemon.json"),
  JSON.stringify({ protocol: 1, pid: process.pid, host: "127.0.0.1", port, version: "bench", roots: [], startedAt: "" }),
);
const env = { ...process.env, HOME: home, USERPROFILE: home, AXIOM_HOOK_FALLBACK: join(home, "none") };
const payload = JSON.stringify({ tool_name: "Write", tool_input: { file_path: "src/a.ts", content: "x" } });

// spawnSync would block the event loop and the in-process mock could not answer: spawn async.
function once(args, input, program = exe) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const p = spawn(program, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    p.on("error", reject);
    p.on("close", (code) => resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, code }));
    p.stdin.end(input);
  });
}
async function bench(label, args, input, program = exe) {
  const ms = [];
  await once(args, input, program); // warm the file cache
  for (let i = 0; i < runs; i++) {
    const r = await once(args, input, program);
    if (r.code !== 0) throw new Error(`${label}: exit ${r.code}`);
    ms.push(r.ms);
  }
  ms.sort((a, b) => a - b);
  const p = (q) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))].toFixed(1);
  console.log(`${label.padEnd(22)} n=${runs} p50=${p(0.5)} ms p90=${p(0.9)} min=${ms[0].toFixed(1)} ms`);
}

console.log(`binary ${exe} = ${statSync(exe).size} bytes`);
// Same-moment baselines: process-spawn floor on this machine right now.
await bench("baseline node -e 0", ["-e", "0"], "", process.execPath);
if (process.platform === "win32") {
  await bench("baseline hostname.exe", [], "", "C:\\Windows\\System32\\hostname.exe");
}
await bench("--version", ["--version"], "");
await bench("gate round-trip", ["gate", "--stdin", "--format", "claude"], payload);
server.close();
rmSync(home, { recursive: true, force: true });
