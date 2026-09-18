// Tracks concurrency via a counter dir: one file per live process, records the peak.
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.GUARD_COUNTER_DIR;
mkdirSync(dir, { recursive: true });
const mine = join(dir, `live-${process.pid}`);
writeFileSync(mine, "1");
const live = readdirSync(dir).filter((f) => f.startsWith("live-")).length;
writeFileSync(join(dir, `peak-${process.pid}`), String(live));
setTimeout(() => {
  unlinkSync(mine);
  process.stdout.write(JSON.stringify({ ok: true }));
}, 300);
