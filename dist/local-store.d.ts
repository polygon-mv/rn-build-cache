/**
 * The per-machine cache: `~/.cache/rn-build-cache/<key>/{app.apk,meta.json}`.
 *
 * Least-recently-used entries are pruned after every store. A release APK is typically 50-150 MB,
 * so the default keeps only a few.
 */
import type { LocalStore } from "./lookup.js";
export declare function defaultCacheDir(): string;
export declare function sha256File(path: string): Promise<string>;
export declare function createLocalStore(root: string): LocalStore & {
    prune(keep: number, protect: string): Promise<string[]>;
};
