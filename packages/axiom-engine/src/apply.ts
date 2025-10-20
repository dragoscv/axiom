import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Manifest } from "./manifest.js";

export interface ApplyOptions {
    manifest: Manifest;
    mode: "fs" | "pr";
    repoPath: string;
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
    error?: string;
}

/**
 * Aplică un manifest: scrie fișierele fie direct (fs), fie prin PR (git)
 */
export async function apply(options: ApplyOptions): Promise<ApplyResult> {
    const { manifest, mode, repoPath, branchName, commitMessage } = options;

    if (mode === "fs") {
        return applyFS(manifest, repoPath);
    } else {
        return applyPR(manifest, repoPath, branchName, commitMessage);
    }
}

/**
 * Mod direct: scrie fișierele pe disc
 */
function applyFS(manifest: Manifest, repoPath: string): ApplyResult {
    const filesWritten: string[] = [];

    try {
        // Manifestul conține artifacts care au fost deja scrise de generate()
        // Aici doar validăm că există
        for (const artifact of manifest.artifacts) {
            const fullPath = path.join(repoPath, artifact.path);
            if (fs.existsSync(fullPath)) {
                filesWritten.push(artifact.path);
            }
        }

        return {
            success: true,
            mode: "fs",
            filesWritten
        };
    } catch (err: any) {
        return {
            success: false,
            mode: "fs",
            filesWritten,
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
        const isGitRepo = fs.existsSync(path.join(repoPath, ".git"));
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

            const relativePath = artifact.path;
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
