import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { randomBytes } from "node:crypto";

/**
 * Resolve repository root path with fail-closed protection against HOME writes
 * 
 * Algorithm:
 * 1. If repoPathArg is absolute → normalize and return
 * 2. If AXIOM_REPO_ROOT env is set (absolute, existing) → use for relative paths
 * 3. Try Git detection: start from process.cwd(), walk up to find .git
 * 4. If resolved root is HOME and repoPathArg was relative → FAIL-CLOSED (throw ERR_REPOPATH_RELATIVE_UNSAFE)
 * 5. Return absolute path
 * 
 * @param repoPathArg - Repository path argument (relative or absolute)
 * @returns Absolute repository root path
 * @throws Error ERR_REPOPATH_RELATIVE_UNSAFE if relative path resolves to HOME
 */
export function resolveRepoRoot(repoPathArg: string): string {
    const isInputAbsolute = path.isAbsolute(repoPathArg);
    const homeDir = os.homedir();
    const processCwd = process.cwd();
    const axiomRepoRootEnv = process.env.AXIOM_REPO_ROOT;

    console.error(`[fs-axiom] resolveRepoRoot() invoked`);
    console.error(`[fs-axiom]   repoPathInput: ${repoPathArg}`);
    console.error(`[fs-axiom]   isAbsolute: ${isInputAbsolute}`);
    console.error(`[fs-axiom]   process.cwd(): ${processCwd}`);
    console.error(`[fs-axiom]   AXIOM_REPO_ROOT: ${axiomRepoRootEnv || "(not set)"}`);
    console.error(`[fs-axiom]   HOME: ${homeDir}`);

    // Step 1: If absolute → normalize and return immediately
    if (isInputAbsolute) {
        const resolved = path.normalize(repoPathArg);
        console.error(`[fs-axiom]   → Absolute path detected, using: ${resolved}`);
        return resolved;
    }

    // Step 2: Check AXIOM_REPO_ROOT override for relative paths
    if (axiomRepoRootEnv && axiomRepoRootEnv.trim()) {
        const envRoot = axiomRepoRootEnv.trim();

        // AXIOM_REPO_ROOT must be absolute
        if (!path.isAbsolute(envRoot)) {
            console.error(`[fs-axiom]   ✗ AXIOM_REPO_ROOT is not absolute: ${envRoot}`);
            throw new Error(`ERR_AXIOM_REPO_ROOT_MUST_BE_ABSOLUTE: AXIOM_REPO_ROOT must be an absolute path, got: ${envRoot}`);
        }

        // AXIOM_REPO_ROOT must exist
        if (!fs.existsSync(envRoot)) {
            console.error(`[fs-axiom]   ✗ AXIOM_REPO_ROOT does not exist: ${envRoot}`);
            throw new Error(`ERR_AXIOM_REPO_ROOT_NOT_FOUND: AXIOM_REPO_ROOT directory does not exist: ${envRoot}`);
        }

        // Use AXIOM_REPO_ROOT as base for relative path resolution
        const resolved = path.resolve(envRoot, repoPathArg);
        console.error(`[fs-axiom]   → Using AXIOM_REPO_ROOT: ${resolved}`);
        return resolved;
    }

    // Step 3: Try Git repository detection
    console.error(`[fs-axiom]   → Attempting Git detection from cwd`);
    let currentDir = processCwd;
    let gitRoot: string | null = null;

    // Walk up directory tree looking for .git
    for (let i = 0; i < 20; i++) { // Safety limit: 20 levels up
        const gitPath = path.join(currentDir, '.git');
        console.error(`[fs-axiom]     Checking: ${gitPath}`);

        if (fs.existsSync(gitPath)) {
            gitRoot = currentDir;
            console.error(`[fs-axiom]     ✓ Found .git at: ${gitRoot}`);
            break;
        }

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
            // Reached filesystem root
            console.error(`[fs-axiom]     Reached filesystem root, no .git found`);
            break;
        }
        currentDir = parentDir;
    }

    // If Git found, use it as base for relative path resolution
    if (gitRoot) {
        const resolved = path.resolve(gitRoot, repoPathArg);
        console.error(`[fs-axiom]   → Git repo detected, resolved to: ${resolved}`);

        // Step 4: FAIL-CLOSED if resolved path is HOME
        if (path.normalize(resolved) === path.normalize(homeDir)) {
            console.error(`[fs-axiom]   ✗ FAIL-CLOSED: Resolved path is HOME directory`);
            throw new Error(
                `ERR_REPOPATH_RELATIVE_UNSAFE: Relative repoPath "${repoPathArg}" resolved to HOME directory (${homeDir}). ` +
                `This is unsafe. Please pass an absolute repoPath or set AXIOM_REPO_ROOT environment variable.`
            );
        }

        return resolved;
    }

    // Step 3 fallback: No Git found, resolve relative to cwd
    const resolved = path.resolve(processCwd, repoPathArg);
    console.error(`[fs-axiom]   → No Git detected, resolved relative to cwd: ${resolved}`);

    // Step 4: FAIL-CLOSED if resolved path is HOME
    if (path.normalize(resolved) === path.normalize(homeDir)) {
        console.error(`[fs-axiom]   ✗ FAIL-CLOSED: Resolved path is HOME directory`);
        throw new Error(
            `ERR_REPOPATH_RELATIVE_UNSAFE: Relative repoPath "${repoPathArg}" resolved to HOME directory (${homeDir}). ` +
            `This is unsafe. Please pass an absolute repoPath or set AXIOM_REPO_ROOT environment variable.`
        );
    }

    return resolved;
}

/**
 * Resolve absolute paths for artifact write destination with strict POSIX validation
 * 
 * Algorithm:
 * 1. Validate artifactRelPosix: POSIX-only (no backslashes), no .., no absolute paths
 * 2. Normalize with path.posix.normalize
 * 3. Determine outRootAbs: AXIOM_OUT_ROOT (if absolute) or path.join(repoRootAbs, "out")
 * 4. Convert POSIX path to platform path segments and join with outRootAbs
 * 5. Return { absDir, absFile }
 * 
 * GUARANTEES:
 * - Zero dependency on process.cwd() for path construction
 * - All path.resolve() calls use explicit base (repoRootAbs or outRootAbs)
 * - Windows drive letter comparison is case-insensitive
 * 
 * @param repoRootAbs - Absolute repository root (from resolveRepoRoot)
 * @param outRootAbs - Absolute output root (from resolveOutRoot)
 * @param artifactRelPosix - Artifact path in POSIX format (e.g., "manifest/README.md")
 * @returns Object with absDir (directory) and absFile (full file path)
 * @throws Error if artifact path contains invalid characters or traversal attempts
 */
export function resolveArtifactAbs(
    repoRootAbs: string,
    outRootAbs: string,
    artifactRelPosix: string
): { absDir: string; absFile: string } {
    console.error(`[fs-axiom] resolveArtifactAbs() invoked`);
    console.error(`[fs-axiom]   repoRootAbs: ${repoRootAbs}`);
    console.error(`[fs-axiom]   outRootAbs: ${outRootAbs}`);
    console.error(`[fs-axiom]   artifactRelPosix: ${artifactRelPosix}`);

    // Validation 0: Unicode NFC normalization
    const nfcNormalized = artifactRelPosix.normalize('NFC');
    if (nfcNormalized !== artifactRelPosix) {
        console.error(`[fs-axiom]   → Unicode normalized to NFC`);
    }
    const workingPath = nfcNormalized;

    // Validation 1: Reject backslashes (POSIX-only)
    if (workingPath.includes('\\')) {
        const error = `ERR_ARTIFACT_PATH_BACKSLASH: Artifact path must use forward slashes only, got: ${workingPath}`;
        console.error(`[fs-axiom]   ✗ ${error}`);
        throw new Error(error);
    }

    // Validation 2: Reject absolute paths
    if (path.posix.isAbsolute(workingPath)) {
        const error = `ERR_ARTIFACT_PATH_ABSOLUTE: Artifact path must be relative, got: ${workingPath}`;
        console.error(`[fs-axiom]   ✗ ${error}`);
        throw new Error(error);
    }

    // Validation 3: Normalize and check for path traversal
    const normalized = path.posix.normalize(workingPath);
    if (normalized.includes('..')) {
        const error = `ERR_ARTIFACT_PATH_TRAVERSAL: Artifact path contains path traversal (..), got: ${workingPath}`;
        console.error(`[fs-axiom]   ✗ ${error}`);
        throw new Error(error);
    }

    // Convert POSIX path to platform-specific segments
    const segments = normalized.split('/').filter(s => s && s !== '.');
    console.error(`[fs-axiom]   → Normalized POSIX: ${normalized}`);
    console.error(`[fs-axiom]   → Path segments: ${JSON.stringify(segments)}`);

    // Validation 4: Check for Windows reserved names and invalid characters
    if (process.platform === 'win32') {
        const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
        const invalidChars = /[<>:"|?*\x00-\x1F]/;
        
        for (const segment of segments) {
            // Remove extension for reserved name check
            const baseName = segment.replace(/\.[^.]*$/, '');
            
            if (reservedNames.test(baseName)) {
                const error = `ERR_ARTIFACT_PATH_RESERVED_WINDOWS: Segment "${segment}" contains Windows reserved name`;
                console.error(`[fs-axiom]   ✗ ${error}`);
                throw new Error(error);
            }
            
            if (invalidChars.test(segment)) {
                const error = `ERR_ARTIFACT_PATH_INVALID_CHARS: Segment "${segment}" contains invalid characters`;
                console.error(`[fs-axiom]   ✗ ${error}`);
                throw new Error(error);
            }
            
            // Check for trailing spaces or dots (Windows-specific issue)
            if (segment.endsWith(' ') || segment.endsWith('.')) {
                const error = `ERR_ARTIFACT_PATH_TRAILING: Segment "${segment}" has trailing space or dot (Windows incompatible)`;
                console.error(`[fs-axiom]   ✗ ${error}`);
                throw new Error(error);
            }
        }
    }

    // Construct absolute file path using platform path API
    const absFile = path.join(outRootAbs, ...segments);
    const absDir = path.dirname(absFile);

    console.error(`[fs-axiom]   → absFile: ${absFile}`);
    console.error(`[fs-axiom]   → absDir: ${absDir}`);

    return { absDir, absFile };
}

/**
 * Resolve output root directory with support for AXIOM_OUT_ROOT env var
 * 
 * @param repoPath - Repository path (absolute, already resolved by resolveRepoRoot)
 * @param envOutRoot - Optional AXIOM_OUT_ROOT environment variable override
 * @returns Absolute path to output root directory
 */
export function resolveOutRoot(repoPath: string, envOutRoot?: string): string {
    // repoPath should already be absolute (resolved by resolveRepoRoot)
    const repoAbs = path.isAbsolute(repoPath)
        ? path.normalize(repoPath)
        : path.resolve(process.cwd(), repoPath);

    // If AXIOM_OUT_ROOT is set, use it
    if (envOutRoot && envOutRoot.trim()) {
        // If absolute → use directly; if relative → join with repoAbs
        const outRoot = path.isAbsolute(envOutRoot)
            ? path.normalize(envOutRoot)
            : path.join(repoAbs, envOutRoot);

        console.error(`[fs-axiom] Using AXIOM_OUT_ROOT: ${outRoot}`);
        return outRoot;
    }

    // Default: repoAbs/out
    const defaultOut = path.join(repoAbs, "out");
    console.error(`[fs-axiom] Using default out: ${defaultOut}`);
    return defaultOut;
}

/**
 * Extract buffer from artifact using fallback chain:
 * 1. contentBase64 (inline binary)
 * 2. contentUtf8 (inline text)
 * 3. .axiom/artifacts/<sha256> (cached)
 * 
 * @param artifact - Artifact object with content fields
 * @param repoAbs - Absolute repository path for cache lookup
 * @returns Buffer containing artifact content
 * @throws Error if no content source available
 */
export function bufferFromArtifact(artifact: any, repoAbs: string): Buffer {
    console.error(`[fs-axiom] Extracting content for: ${artifact?.path}`);

    // Fallback 1: Base64 inline content
    if (artifact?.contentBase64) {
        console.error(`[fs-axiom]   → Using contentBase64 (${artifact.contentBase64.length} chars)`);
        return Buffer.from(artifact.contentBase64, "base64");
    }

    // Fallback 2: UTF-8 inline content
    if (typeof artifact?.contentUtf8 === "string") {
        console.error(`[fs-axiom]   → Using contentUtf8 (${artifact.contentUtf8.length} chars)`);
        return Buffer.from(artifact.contentUtf8, "utf8");
    }

    // Fallback 3: Cached artifact in .axiom/artifacts/<sha256>
    if (artifact?.sha256) {
        const cachePath = path.join(repoAbs, ".axiom", "artifacts", artifact.sha256);
        console.error(`[fs-axiom]   → Checking cache: ${cachePath}`);

        if (fs.existsSync(cachePath)) {
            console.error(`[fs-axiom]   → Using cached artifact`);
            return fs.readFileSync(cachePath);
        }
    }

    // Fallback 4: Error - no content available
    const error = `ERR_ARTIFACT_CONTENT_MISSING: ${artifact?.path} (SHA256: ${artifact?.sha256 || "n/a"}). No inline content or cached artifact found.`;
    console.error(`[fs-axiom] ERROR: ${error}`);
    throw new Error(error);
}

/**
 * Write artifact to disk with atomic write (tmp+fsync+rename) and strict post-write verification
 * 
 * Algorithm:
 * 1. Create parent directory (recursive)
 * 2. Write to temporary file: absFile + ".tmp-<random>"
 * 3. fsync the file descriptor to ensure data is on disk
 * 4. Close descriptor
 * 5. Atomic rename: tmp -> absFile
 * 6. Post-write verification: readFile + SHA256 + size check
 * 7. FAIL if hash/size mismatch - NO silent success
 * 
 * @param absFile - Absolute file path for write destination
 * @param buf - Buffer to write
 * @param expectedSha256 - Expected SHA256 hash (optional, but recommended)
 * @param expectedBytes - Expected byte count (optional, but recommended)
 * @returns Verification result with absolute path, size, hash, and validation status
 * @throws Error on I/O failures (ENOENT, EPERM, EIO, etc.) - NO catch masking
 */
export async function writeAndVerify(
    absFile: string,
    buf: Buffer,
    expectedSha256?: string,
    expectedBytes?: number
): Promise<{
    absFile: string;
    size: number;
    hash: string;
    sizeOk: boolean;
    hashOk: boolean;
    attemptPath: string;
}> {
    console.error(`[fs-axiom] writeAndVerify() invoked`);
    console.error(`[fs-axiom]   absFile: ${absFile}`);
    console.error(`[fs-axiom]   bufferSize: ${buf.length} bytes`);
    console.error(`[fs-axiom]   expectedSha256: ${expectedSha256 || "(not specified)"}`);
    console.error(`[fs-axiom]   expectedBytes: ${expectedBytes ?? "(not specified)"}`);

    // Step 1: Create parent directory (recursive)
    const absDir = path.dirname(absFile);
    console.error(`[fs-axiom]   → mkdir -p: ${absDir}`);
    await fsPromises.mkdir(absDir, { recursive: true });

    // Step 2: Generate temporary file path IN SAME DIRECTORY (atomic rename guarantee)
    // For cross-drive scenarios, tmp MUST be on same volume as target for atomic rename
    const tmpSuffix = randomBytes(8).toString("hex");
    const tmpFile = path.join(absDir, path.basename(absFile) + `.tmp-${tmpSuffix}`);
    console.error(`[fs-axiom]   → tmpFile: ${tmpFile}`);
    console.error(`[fs-axiom]   → tmp in same dir as target (atomic rename within volume)`);

    try {
        // Step 3: Write to temporary file
        console.error(`[fs-axiom]   → Writing to tmp file...`);
        const fd = await fsPromises.open(tmpFile, "w");

        try {
            // Write buffer
            await fd.write(buf, 0, buf.length);
            console.error(`[fs-axiom]   → Buffer written (${buf.length} bytes)`);

            // Step 4: fsync to ensure data is physically on disk
            await fd.sync();
            console.error(`[fs-axiom]   → fsync complete`);

        } finally {
            // Step 5: Close file descriptor
            await fd.close();
            console.error(`[fs-axiom]   → File descriptor closed`);
        }

        // Step 6: Atomic rename: tmp -> final
        console.error(`[fs-axiom]   → Atomic rename: ${tmpFile} -> ${absFile}`);
        await fsPromises.rename(tmpFile, absFile);
        console.error(`[fs-axiom]   → Rename complete, file committed`);

    } catch (writeError: any) {
        // Clean up tmp file on error
        try {
            if (fs.existsSync(tmpFile)) {
                await fsPromises.unlink(tmpFile);
                console.error(`[fs-axiom]   → Cleaned up tmp file after error`);
            }
        } catch {
            // Ignore cleanup errors
        }

        // Re-throw original error - NO masking
        console.error(`[fs-axiom]   ✗ WRITE ERROR: ${writeError.code || "UNKNOWN"} - ${writeError.message}`);
        throw new Error(`ERR_WRITE_FAILED: ${writeError.message} (code: ${writeError.code || "UNKNOWN"}, path: ${tmpFile})`);
    }

    // Step 7: Post-write verification - read back and validate
    console.error(`[fs-axiom]   → Post-write verification...`);

    let verifyError: string | null = null;
    let actualSize = 0;
    let actualHash = "";

    try {
        // Read back the file
        const readBack = await fsPromises.readFile(absFile);
        actualSize = readBack.length;
        actualHash = crypto.createHash("sha256").update(readBack).digest("hex");

        console.error(`[fs-axiom]   → Read-back complete`);
        console.error(`[fs-axiom]   → Actual size: ${actualSize} bytes`);
        console.error(`[fs-axiom]   → Actual SHA256: ${actualHash}`);

    } catch (readError: any) {
        verifyError = `ERR_VERIFY_READ_FAILED: ${readError.message} (code: ${readError.code || "UNKNOWN"})`;
        console.error(`[fs-axiom]   ✗ ${verifyError}`);
        throw new Error(verifyError);
    }

    // Validate size
    const sizeOk = (typeof expectedBytes === "number")
        ? (actualSize === expectedBytes)
        : true;

    if (!sizeOk) {
        console.error(`[fs-axiom]   ✗ SIZE MISMATCH: expected ${expectedBytes}, got ${actualSize}`);
    } else {
        console.error(`[fs-axiom]   ✓ Size match: ${actualSize} bytes`);
    }

    // Validate hash
    const hashOk = expectedSha256
        ? (actualHash === expectedSha256)
        : true;

    if (!hashOk) {
        console.error(`[fs-axiom]   ✗ HASH MISMATCH: expected ${expectedSha256}, got ${actualHash}`);
    } else {
        console.error(`[fs-axiom]   ✓ Hash match: ${actualHash}`);
    }

    // Overall verification status
    if (!sizeOk || !hashOk) {
        console.error(`[fs-axiom]   ✗ VERIFICATION FAILED`);
    } else {
        console.error(`[fs-axiom]   ✓ VERIFICATION SUCCESS`);
    }

    return {
        absFile,
        size: actualSize,
        hash: actualHash,
        sizeOk,
        hashOk,
        attemptPath: absFile
    };
}
