import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";

/**
 * Artifact content store by SHA256 hash.
 * Stores artifact content in .axiom/cache/<sha256> for deterministic apply.
 */

export interface ArtifactStoreConfig {
  /** Root directory for the artifact store (default: .axiom/cache in repo root) */
  cacheDir?: string;
}

export class ArtifactStore {
  private readonly cacheDir: string;

  constructor(repoRoot: string, config: ArtifactStoreConfig = {}) {
    // Use .axiom/cache/v1 as per spec
    this.cacheDir = config.cacheDir || join(repoRoot, ".axiom", "cache", "v1");
  }

  /**
   * Store artifact content by SHA256 hash
   */
  async put(sha256: string, content: Buffer | string): Promise<void> {
    // Validate SHA256 format
    if (!/^[a-f0-9]{64}$/i.test(sha256)) {
      throw new Error(`Invalid SHA256 format: ${sha256}`);
    }

    // Ensure cache directory exists
    await mkdir(this.cacheDir, { recursive: true });

    // Write content to cache file
    const cachePath = join(this.cacheDir, sha256);
    await writeFile(cachePath, content, "utf-8");
  }

  /**
   * Retrieve artifact content by SHA256 hash
   * @throws Error if artifact not found in store
   */
  async get(sha256: string): Promise<Buffer> {
    const cachePath = join(this.cacheDir, sha256);
    
    try {
      return await readFile(cachePath);
    } catch (error: any) {
      if (error.code === "ENOENT") {
        throw new Error(
          `ERR_ARTIFACT_CONTENT_MISSING: Artifact content not found in store. ` +
          `SHA256: ${sha256}, Expected path: ${cachePath}`
        );
      }
      throw error;
    }
  }

  /**
   * Calculate SHA256 hash of content
   */
  static hash(content: Buffer | string): string {
    return createHash("sha256")
      .update(content)
      .digest("hex");
  }

  /**
   * Verify content matches expected SHA256
   * @throws Error if hash mismatch
   */
  static verify(content: Buffer | string, expectedSha256: string): void {
    const actualSha256 = this.hash(content);
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        `ERR_SHA256_MISMATCH: Content hash mismatch. ` +
        `Expected: ${expectedSha256}, Actual: ${actualSha256}`
      );
    }
  }
}
