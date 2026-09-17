import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

/**
 * fs_probe_write - Independent cross-drive write testing tool
 * 
 * Tests filesystem write capabilities independently of AXIOM manifest logic.
 * Useful for validating cross-drive writes and arbitrary path support.
 */
export async function fs_probe_write(args: {
    destAbs: string;
    contentUtf8?: string;
    contentBase64?: string;
}): Promise<{
    success: boolean;
    absPath: string;
    hash: string;
    size: number;
    error?: string;
}> {
    const { destAbs, contentUtf8, contentBase64 } = args;

    try {
        console.error(`[fs-probe-write] Testing write to: ${destAbs}`);

        // Determine content source
        let content: Buffer;
        if (contentBase64) {
            console.error(`[fs-probe-write]   Source: contentBase64 (${contentBase64.length} chars)`);
            content = Buffer.from(contentBase64, "base64");
        } else if (contentUtf8) {
            console.error(`[fs-probe-write]   Source: contentUtf8 (${contentUtf8.length} chars)`);
            content = Buffer.from(contentUtf8, "utf8");
        } else {
            throw new Error("ERR_NO_CONTENT: Must provide either contentUtf8 or contentBase64");
        }

        console.error(`[fs-probe-write]   Buffer size: ${content.length} bytes`);

        // Create parent directory
        const dir = path.dirname(destAbs);
        console.error(`[fs-probe-write]   mkdir: ${dir}`);
        await fs.promises.mkdir(dir, { recursive: true });

        // Write file
        console.error(`[fs-probe-write]   Writing...`);
        await fs.promises.writeFile(destAbs, content);

        // Read back and verify
        console.error(`[fs-probe-write]   Reading back...`);
        const readBack = fs.readFileSync(destAbs);
        const hash = crypto.createHash("sha256").update(readBack).digest("hex");
        const size = readBack.length;

        console.error(`[fs-probe-write]   ✓ Read-back size: ${size} bytes`);
        console.error(`[fs-probe-write]   ✓ Read-back SHA256: ${hash}`);

        return {
            success: true,
            absPath: destAbs,
            hash,
            size
        };
    } catch (error: any) {
        console.error(`[fs-probe-write]   ✗ ERROR: ${error.message}`);
        return {
            success: false,
            absPath: destAbs,
            hash: "",
            size: 0,
            error: error.message
        };
    }
}

export const fs_probe_write_def = {
    name: "fs_probe_write",
    description: "Independent cross-drive write testing tool for validating filesystem capabilities",
    inputSchema: {
        type: "object",
        properties: {
            destAbs: {
                type: "string",
                description: "Absolute destination path (can be on any drive)"
            },
            contentUtf8: {
                type: "string",
                description: "Optional UTF-8 content to write"
            },
            contentBase64: {
                type: "string",
                description: "Optional Base64-encoded content to write"
            }
        },
        required: ["destAbs"]
    }
};
