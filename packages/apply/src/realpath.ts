import { realpath as realpathCb } from "node:fs";
import { promisify } from "node:util";

/**
 * `fs.realpath.native` (§4.4: 8.3-name and drive-letter-case normalisation on
 * Windows). The `node:fs/promises` API has no `.native` variant, so promisify
 * the callback one.
 */
export const realpathNative: (p: string) => Promise<string> = promisify(realpathCb.native);
