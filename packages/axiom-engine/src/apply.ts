import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, dirname, resolve, isAbsolute, sep } from "node:path";
import type { Manifest } from "./manifest.js";
import { toPosixPath } from "./util.js";
import { ArtifactStore } from "./artifactStore.js";

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
    error?: string;
}

/**
 * Aplică un manifest: scrie fișierele fie direct (fs), fie prin PR (git)
 */
export async function apply(options: ApplyOptions): Promise<ApplyResult> {
    const { manifest, mode, branchName, commitMessage } = options;

    // Default repoPath = process.cwd()
    const repoRoot = options.repoPath || process.cwd();

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
}

/**
 * Validează că un path nu conține traversal și e în limitele repoPath/out
 */
function validateSafePath(repoPath: string, artifactPath: string): void {
    // Normalizează artifact path la POSIX
    const posixPath = toPosixPath(artifactPath);

    // Respinge path-uri absolute
    if (isAbsolute(posixPath)) {
        throw new Error(`Absolute paths not allowed: ${posixPath}`);
    }

    // Respinge traversal prin ..
    if (posixPath.includes('..')) {
        throw new Error(`Path traversal not allowed: ${posixPath}`);
    }

    // Calculează path-ul final și verifică că e sub repoPath/out
    const safeParts = posixPath.split('/').filter(p => p && p !== '.');
    const resolved = resolve(repoPath, 'out', ...safeParts);
    const expectedPrefix = resolve(repoPath, 'out');

    if (!resolved.startsWith(expectedPrefix + sep)) {
        throw new Error(`Path outside allowed directory: ${posixPath}`);
    }
}

/**
 * Mod direct: scrie fișierele pe disc folosind ArtifactStore
 */
async function applyFS(manifest: Manifest, repoRoot: string): Promise<ApplyResult> {
    const filesWritten: string[] = [];
    const artifactStore = new ArtifactStore(repoRoot);

    try {
        // Asigură că directorul out/ există
        const outDir = join(repoRoot, "out");
        await mkdir(outDir, { recursive: true });

        // Procesează fiecare artifact
        for (const artifact of manifest.artifacts) {
            // Skip manifest.json (e meta)
            if (artifact.path === "manifest.json") continue;

            // Validare securitate: respinge path traversal
            validateSafePath(repoRoot, artifact.path);

            // Normalizează path la POSIX
            const posixPath = toPosixPath(artifact.path);

            // Determină path-ul pe disc - IMPORTANT: formează întotdeauna out/...
            let diskRel = posixPath;
            if (posixPath.startsWith('out/')) {
                diskRel = posixPath.substring(4); // Remove 'out/'
            } else if (posixPath.startsWith('./out/')) {
                diskRel = posixPath.substring(6); // Remove './out/'
            }

            // Construiește full path: repoRoot/out/diskRel
            const diskParts = diskRel.split('/');
            const fullPath = join(repoRoot, 'out', ...diskParts);

            // **CONTENT FALLBACK ORDERING** per spec:
            // 1. contentUtf8 → Buffer
            // 2. contentBase64 → decode
            // 3. artifactStore.get(sha256)
            // 4. ERR_ARTIFACT_CONTENT_MISSING
            let content: Buffer;

            if (artifact.contentUtf8 !== undefined) {
                // Fallback 1: UTF-8 embedded content
                content = Buffer.from(artifact.contentUtf8, "utf-8");
            } else if (artifact.contentBase64 !== undefined) {
                // Fallback 2: Base64 embedded content
                content = Buffer.from(artifact.contentBase64, "base64");
            } else {
                // Fallback 3: Try artifact store
                try {
                    content = await artifactStore.get(artifact.sha256);
                } catch (error: any) {
                    // Fallback 4: Error if all sources exhausted
                    throw new Error(
                        `ERR_ARTIFACT_CONTENT_MISSING: ${artifact.path} (SHA256: ${artifact.sha256}). ` +
                        `Content not found in manifest (contentUtf8/contentBase64) or artifact store. ` +
                        `Run generate() first to populate store or include content in manifest.`
                    );
                }
            }

            // Creează directorul părinte
            await mkdir(dirname(fullPath), { recursive: true });

            // Scrie fișierul (strict fs/promises, no virtual FS)
            await writeFile(fullPath, content);

            // Verifică SHA256 după scriere (strict validation)
            const writtenContent = await readFile(fullPath);
            try {
                ArtifactStore.verify(writtenContent, artifact.sha256);
            } catch (error: any) {
                throw new Error(
                    `ERR_SHA256_MISMATCH for ${artifact.path}: ${error.message}`
                );
            }

            // Raportează cu prefix out/ și strict POSIX (fără backslash)
            const reportPath = `out/${diskRel}`.replace(/\\/g, '/');
            filesWritten.push(reportPath);
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
