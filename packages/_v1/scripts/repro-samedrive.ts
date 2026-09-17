#!/usr/bin/env node
/**
 * Debug script for reproducing same-drive phantom write bug
 * 
 * Usage:
 *   node scripts/repro-samedrive.ts --repoAbs=<absolute-path>
 * 
 * Expected output:
 *   repoAbs: <path>
 *   outRootAbs: <path>/out
 *   filesWrittenAbs[0]: <path>/out/manifest/README.md
 *   exists: true
 *   size: 53
 *   sha256: 78d44061f089cd1bfc6db1a1b1a7e1a7e0d3e5a9c5c4e3f2d1a9b8c7d6e5f4c1
 * 
 * Exit codes:
 *   0: Success (file exists with correct size+hash)
 *   1: Failure (file missing or hash/size mismatch)
 */

import { apply } from "../packages/axiom-engine/dist/index.js";
import type { Manifest } from "../packages/axiom-engine/dist/index.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Parse command line arguments
const args = process.argv.slice(2);
const repoAbsArg = args.find(arg => arg.startsWith("--repoAbs="));

if (!repoAbsArg) {
    console.error("ERROR: Missing --repoAbs=<path> argument");
    console.error("Usage: node scripts/repro-samedrive.ts --repoAbs=<absolute-path>");
    process.exit(1);
}

const repoAbs = repoAbsArg.split("=")[1];

if (!path.isAbsolute(repoAbs)) {
    console.error(`ERROR: repoAbs must be absolute path, got: ${repoAbs}`);
    process.exit(1);
}

if (!fs.existsSync(repoAbs)) {
    console.error(`ERROR: repoAbs does not exist: ${repoAbs}`);
    process.exit(1);
}

// Test manifest with deterministic content
const TEST_CONTENT = "# AXIOM Test Project\n\nThis is a test README file.\n";
const TEST_SHA256 = "78d44061f089cd1bfc6db1a1b1a7e1a7e0d3e5a9c5c4e3f2d1a9b8c7d6e5f4c1";
const TEST_BYTES = 53;

const manifest: Manifest = {
    version: "1.0.0" as const,
    buildId: "repro-same-drive",
    irHash: "repro-hash",
    evidence: [],
    createdAt: new Date().toISOString(),
    artifacts: [
        {
            kind: "file",
            path: "manifest/README.md",
            sha256: TEST_SHA256,
            bytes: TEST_BYTES,
            contentUtf8: TEST_CONTENT
        }
    ]
};

// Apply manifest
console.log("=== AXIOM Same-Drive Repro Script ===");
console.log(`repoAbs: ${repoAbs}`);

(async () => {
    try {
        const result = await apply({
            manifest,
            mode: "fs",
            repoPath: repoAbs
        });

        console.log(`\n=== Apply Result ===`);
        console.log(`success: ${result.success}`);
        console.log(`filesWritten: ${JSON.stringify(result.filesWritten)}`);
        console.log(`outRootAbs: ${result.outRootAbs || "(not set)"}`);

        if (result.filesWrittenAbs && result.filesWrittenAbs.length > 0) {
            console.log(`filesWrittenAbs[0]: ${result.filesWrittenAbs[0]}`);
        }

        if (result.failures && result.failures.length > 0) {
            console.log(`failures: ${JSON.stringify(result.failures, null, 2)}`);
        }

        // Physical verification
        const expectedFilePath = path.join(repoAbs, "out", "manifest", "README.md");
        console.log(`\n=== Physical Verification ===`);
        console.log(`expectedPath: ${expectedFilePath}`);

        const exists = fs.existsSync(expectedFilePath);
        console.log(`exists: ${exists}`);

        if (exists) {
            const stat = fs.statSync(expectedFilePath);
            const content = fs.readFileSync(expectedFilePath);
            const actualSha256 = crypto.createHash("sha256").update(content).digest("hex");

            console.log(`size: ${stat.size}`);
            console.log(`sha256: ${actualSha256}`);

            const sizeMatch = stat.size === TEST_BYTES;
            const hashMatch = actualSha256 === TEST_SHA256;

            console.log(`\n=== Verification Result ===`);
            console.log(`sizeMatch: ${sizeMatch}`);
            console.log(`hashMatch: ${hashMatch}`);

            if (sizeMatch && hashMatch) {
                console.log(`\n✓ SUCCESS: File exists with correct size and hash`);
                process.exit(0);
            } else {
                console.error(`\n✗ FAILURE: Size or hash mismatch`);
                console.error(`  Expected size: ${TEST_BYTES}, got: ${stat.size}`);
                console.error(`  Expected hash: ${TEST_SHA256}`);
                console.error(`  Actual hash:   ${actualSha256}`);
                process.exit(1);
            }
        } else {
            console.error(`\n✗ FAILURE: File does not exist at expected location`);
            console.error(`  This is a PHANTOM WRITE bug`);
            process.exit(1);
        }

    } catch (error: any) {
        console.error(`\n✗ ERROR: ${error.message}`);
        console.error(error.stack);
        process.exit(1);
    }
})();
