/**
 * The shared remote cache: assets on ONE GitHub release (default tag `native-build-cache`).
 *
 * One release rather than one per fingerprint: a new entry per native change would push real
 * releases down the list. This one is created once and sinks below them as they are published —
 * exactly what an internal store wants. Release assets are not billed storage, and `gh` reaches
 * them from CI and from a laptop alike (Actions cache is CI-only and branch-scoped).
 *
 * An entry is `<key>.apk` + `<key>.json`; the JSON is uploaded last, so it marks a complete entry.
 */
import type { CacheStore } from "./lookup.js";
import { type CacheMeta } from "./meta.js";
interface ReleaseAsset {
    readonly name: string;
    readonly createdAt: string;
}
export interface GithubStore extends CacheStore {
    put(meta: CacheMeta, apkPath: string): Promise<void>;
    prune(keepPerVariant: number): Promise<string[]>;
    newestMeta(variant: string): Promise<CacheMeta | null>;
}
export declare function createGithubStore(options: {
    readonly cwd: string;
    readonly workDir: string;
    readonly tag: string;
    readonly repo: string | null;
}): GithubStore;
/**
 * Asset names to delete so each variant keeps its `keep` newest entries. An entry's age is its
 * JSON's upload time; an APK without a JSON (an interrupted upload) is always removed.
 */
export declare function entriesToPrune(assets: readonly ReleaseAsset[], keep: number): string[];
export {};
