import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, dirname, resolve, isAbsolute, sep } from "node:path";
import type { Manifest } from "./manifest.js";
import { toPosixPath } from "./util.js";
import { ArtifactStore } from "./artifactStore.js";
import { resolveRepoRoot, resolveOutRoot, resolveArtifactAbs, bufferFromArtifact, writeAndVerify } from "./lib/fs-axiom.js";

export interface ApplyOptions {
    manifest: Manifest;
    mode: "fs" | "pr";
    repoPath?: string; // Optional - default process.cwd()
    branchName?: string;
    commitMessage?: string;
}

export interface ApplyResult {
    success: boolean;
    mode: "fs" | "pr";
    branch?: string;
    commit?: string;
    prUrl?: string;
    filesWritten: string[];
    filesWrittenAbs?: string[]; // Absolute paths for transparency
    outRootAbs?: string;         // NEW v1.0.23: Output root used for writes
    failures?: Array<{
        path: string;
        reason: string;
        expected?: { sha256?: string; bytes?: number };
        actual?: { sha256?: string; bytes?: number };
        attemptPath?: string;    // NEW v1.0.23: Actual path attempted for debugging
    }>;
    summary?: {
        totalFiles: number;
        totalBytes: number;
    };
    error?: string;
}

/**
 * Aplică un manifest: scrie fișierele fie direct (fs), fie prin PR (git)
 */
export async function apply(options: ApplyOptions): Promise<ApplyResult> {
    const { manifest, mode, branchName, commitMessage } = options;

    // Default repoPath = process.cwd()
    const repoPathArg = options.repoPath || process.cwd();

    try {
        // FAIL-CLOSED: Resolve repository root with safety checks
        const repoRoot = resolveRepoRoot(repoPathArg);

        // Validare: repoPath trebuie să fie director valid
        if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
            return {
                success: false,
                mode,
                filesWritten: [],
                error: `Invalid repoPath: ${repoRoot} is not a directory`
            };
        }

        if (mode === "fs") {
            return applyFS(manifest, repoRoot);
        } else {
            return applyPR(manifest, repoRoot, branchName, commitMessage);
        }
    } catch (err: any) {
        // Catch ERR_REPOPATH_RELATIVE_UNSAFE and other resolution errors
        console.error(`[apply] ERROR during repoPath resolution: ${err.message}`);
        return {
            success: false,
            mode,
            filesWritten: [],
            failures: [{
                path: "(repoPath resolution)",
                reason: err.message
            }],
            error: err.message
        };
    }
}

/**
 * Mod direct: scrie fișierele pe disc folosind fs-axiom utilities
 * 
 * v1.0.23 CHANGES:
 * - Uses resolveArtifactAbs() for deterministic absolute path calculation
 * - Zero dependency on process.cwd() for write operations
 * - Atomic write with tmp+fsync+rename via writeAndVerify()
 * - Strict post-write verification: NO success without physical file + hash match
 * - Returns outRootAbs for transparency
 */
async function applyFS(manifest: Manifest, repoRoot: string): Promise<ApplyResult> {
    const filesWritten: string[] = [];
    const filesWrittenAbs: string[] = [];
    const failures: ApplyResult['failures'] = [];
    let totalBytes = 0;

    console.error(`[apply] Starting filesystem apply (v1.0.23)`);
    console.error(`[apply]   repoRoot: ${repoRoot}`);

    try {
        // Step 1: Resolve output root with AXIOM_OUT_ROOT support
        const outRootAbs = resolveOutRoot(repoRoot, process.env.AXIOM_OUT_ROOT);
        console.error(`[apply]   outRootAbs: ${outRootAbs}`);

        // Step 2: Normalize repoRoot to absolute path for artifact cache lookup
        const repoRootAbs = isAbsolute(repoRoot)
            ? resolve(repoRoot)
            : resolve(process.cwd(), repoRoot);
        console.error(`[apply]   repoRootAbs: ${repoRootAbs}`);

        // Step 3: Process each artifact
        for (const artifact of manifest.artifacts) {
            // Skip manifest.json (meta file)
            if (artifact.path === "manifest.json") continue;

            console.error(`[apply] Processing artifact: ${artifact.path}`);

            try {
                // Step 3a: Resolve absolute paths using resolveArtifactAbs()
                // This handles POSIX validation, path traversal checks, and deterministic path construction
                const { absFile, absDir } = resolveArtifactAbs(
                    repoRootAbs,
                    outRootAbs,
                    artifact.path
                );

                console.error(`[apply]   → absFile: ${absFile}`);
                console.error(`[apply]   → absDir: ${absDir}`);

                // Step 3b: Extract content using fs-axiom fallback chain
                const content = bufferFromArtifact(artifact, repoRootAbs);
                console.error(`[apply]   → Content extracted: ${content.length} bytes`);

                // Step 3c: Write and verify using atomic write + strict verification
                const result = await writeAndVerify(
                    absFile,
                    content,
                    artifact.sha256,
                    artifact.bytes
                );

                // Step 3d: Check verification results - FAIL if hash/size mismatch
                if (!result.sizeOk || !result.hashOk) {
                    const failureReason = !result.hashOk
                        ? "ERR_POST_WRITE_HASH_MISMATCH"
                        : "ERR_POST_WRITE_SIZE_MISMATCH";

                    failures.push({
                        path: artifact.path,
                        reason: failureReason,
                        expected: {
                            sha256: artifact.sha256,
                            bytes: artifact.bytes
                        },
                        actual: {
                            sha256: result.hash,
                            bytes: result.size
                        },
                        attemptPath: result.attemptPath
                    });

                    console.error(`[apply]   ✗ VERIFICATION FAILED: ${failureReason}`);
                    continue; // Skip adding to filesWritten - NO silent success
                }

                // Step 3e: Success - add to results
                filesWritten.push(artifact.path);
                filesWrittenAbs.push(result.absFile);
                totalBytes += content.length;

                console.error(`[apply]   ✓ SUCCESS: ${artifact.path} (${content.length} bytes)`);

            } catch (artifactError: any) {
                // Track individual artifact failures with detailed context
                failures.push({
                    path: artifact.path,
                    reason: artifactError.message,
                    attemptPath: artifactError.attemptPath || "(unknown)"
                });
                console.error(`[apply]   ✗ ERROR: ${artifact.path} - ${artifactError.message}`);
            }
        }

        // Step 4: Determine overall success - TRUE only if NO failures
        const success = failures.length === 0;

        console.error(`[apply] Complete: success=${success}, files=${filesWritten.length}, failures=${failures.length}`);

        return {
            success,
            mode: "fs",
            filesWritten,
            filesWrittenAbs,
            outRootAbs,
            failures: failures.length > 0 ? failures : undefined,
            summary: {
                totalFiles: filesWritten.length,
                totalBytes
            },
            error: !success
                ? `${failures.length} artifact(s) failed verification or processing`
                : undefined
        };
    } catch (err: any) {
        console.error(`[apply] FATAL ERROR: ${err.message}`);
        return {
            success: false,
            mode: "fs",
            filesWritten,
            filesWrittenAbs,
            failures,
            error: err.message
        };
    }
}

/**
 * Mod PR: creează branch, commit, și PR local
 */
async function applyPR(
    manifest: Manifest,
    repoPath: string,
    branchName?: string,
    commitMessage?: string
): Promise<ApplyResult> {
    const branch = branchName || `axiom-update-${Date.now()}`;
    const message = commitMessage || `AXIOM: Update from manifest ${manifest.buildId}`;
    const filesWritten: string[] = [];

    try {
        // Verifică dacă suntem într-un git repo
        const isGitRepo = existsSync(join(repoPath, ".git"));
        if (!isGitRepo) {
            throw new Error("Not a git repository");
        }

        // 1. Creează branch nou
        await execGit(repoPath, ["checkout", "-b", branch]);

        // 2. Artifacts au fost deja scrise de generate() în out/
        // Adaugă fișierele din out/ la staging
        for (const artifact of manifest.artifacts) {
            // Nu adăugăm manifest.json din root (e meta)
            if (artifact.path === "manifest.json") continue;

            // Artifacts sunt sub out/ în repo
            const relativePath = `out/${artifact.path}`;
            filesWritten.push(relativePath);

            await execGit(repoPath, ["add", relativePath]);
        }

        // 3. Commit
        await execGit(repoPath, ["commit", "-m", message]);

        // 4. Obține commit hash
        const commitHash = await execGit(repoPath, ["rev-parse", "HEAD"]);

        // 5. Încearcă să detecteze remote pentru PR URL
        let prUrl: string | undefined;
        try {
            const remoteUrl = await execGit(repoPath, ["remote", "get-url", "origin"]);
            if (remoteUrl) {
                // Parse GitHub URL (simplificat)
                const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^.]+)/);
                if (match) {
                    const [, owner, repo] = match;
                    prUrl = `https://github.com/${owner}/${repo}/compare/${branch}?expand=1`;
                }
            }
        } catch {
            // Ignore - nu avem remote
        }

        return {
            success: true,
            mode: "pr",
            branch,
            commit: commitHash.trim(),
            prUrl,
            filesWritten
        };
    } catch (err: any) {
        return {
            success: false,
            mode: "pr",
            filesWritten,
            error: err.message
        };
    }
}

/**
 * Helper pentru execuție git
 */
function execGit(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn("git", args, { cwd, shell: true });
        let stdout = "";
        let stderr = "";

        proc.stdout?.on("data", (data) => (stdout += data.toString()));
        proc.stderr?.on("data", (data) => (stderr += data.toString()));

        proc.on("close", (code) => {
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(`git ${args[0]} failed: ${stderr}`));
            }
        });

        proc.on("error", (err) => reject(err));
    });
}
