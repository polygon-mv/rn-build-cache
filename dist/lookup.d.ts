/**
 * Cache lookup order: this machine first, then the shared remote.
 *
 * A remote hit is copied into the local store before use, so the next build on this machine (or
 * a retry after a CI `--cache-only` step) is a local hit. A remote that is down or
 * unauthenticated is a note, never a failure: the build just runs.
 */
import type { CacheMeta } from "./meta.js";
export interface CacheEntry {
    readonly meta: CacheMeta;
    /** A path the caller may read; for the local store it is the stored file itself. */
    readonly apkPath: string;
}
export interface CacheStore {
    readonly name: string;
    get(key: string): Promise<CacheEntry | null>;
}
export interface LocalStore extends CacheStore {
    /** Copies an entry in (from a remote download or a fresh build) and returns the stored copy. */
    put(meta: CacheMeta, apkPath: string): Promise<CacheEntry>;
}
export type LookupResult = {
    readonly hit: true;
    readonly source: string;
    readonly entry: CacheEntry;
    readonly notes: string[];
} | {
    readonly hit: false;
    readonly notes: string[];
};
/** Progress hooks, so a caller can show each tier as it is consulted. */
export interface LookupEvents {
    localDone?(hit: boolean): void;
    remoteStart?(store: CacheStore): void;
    remoteDone?(store: CacheStore, hit: boolean): void;
    remoteFailed?(store: CacheStore, reason: string): void;
}
export declare function lookup(key: string, local: LocalStore, remotes: readonly CacheStore[], events?: LookupEvents): Promise<LookupResult>;
export declare function describe(error: unknown): string;
