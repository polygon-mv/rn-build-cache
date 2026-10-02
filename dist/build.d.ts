/**
 * One build: fingerprint → lookup (local, then remote) → reuse / swap, or a full build that then
 * fills the cache. Reports phases through a {@link Reporter}; prints nothing itself.
 */
import type { ResolvedConfig, ResolvedVariant } from "./config.js";
import { type CacheMeta } from "./meta.js";
import { type Reporter } from "./reporter.js";
export interface BuildOptions {
    readonly variant: ResolvedVariant;
    readonly cache: boolean;
    readonly remote: boolean;
    readonly upload: boolean;
    readonly cacheOnly: boolean;
    readonly prepare: boolean;
    readonly out: string | null;
    readonly explain: boolean;
}
export type Outcome = "hit" | "swap" | "miss" | "none";
export interface BuildResult {
    readonly outcome: Outcome;
    readonly key: string;
    readonly apkPath: string | null;
    /** Where a hit came from. */
    readonly source: string | null;
    /** Wall time of the build that produced the reused entry, for "time saved". */
    readonly baselineSeconds: number | null;
    /** Why a cached entry could not be used, when it could not. */
    readonly fallbackReason: string | null;
    readonly elapsedMs: number;
}
export declare function runBuild(config: ResolvedConfig, options: BuildOptions, reporter: Reporter): Promise<BuildResult>;
export interface CheckResult {
    readonly key: string;
    readonly fingerprint: string;
    /** Whether an entry for the key exists: `local`, `remote`, or null. Nothing is downloaded. */
    readonly cachedIn: "local" | "remote" | null;
    /** The newest shared entry of this variant, when the remote is reachable and has one. */
    readonly newest: {
        readonly key: string;
        readonly commit: string;
        readonly builtAt: string;
    } | null;
    /** On a miss: which fingerprint sources moved since the newest shared entry. */
    readonly changes: string | null;
    readonly elapsedMs: number;
}
/**
 * `--check`: would a build of this variant need Gradle? Fingerprints, then asks the local store
 * and the release whether the key exists, without downloading an APK, bundling or building.
 * Cheap enough for a push-triggered job that only decides whether a native build is needed.
 */
export declare function runCheck(config: ResolvedConfig, variant: ResolvedVariant, options: {
    readonly remote: boolean;
    readonly explain: boolean;
}, reporter: Reporter): Promise<CheckResult>;
/**
 * The env every step sees: the variant's defaults, then its env file, then the caller's
 * environment, then the variant's fixed `env`. In an Expo app `.env*` loading is switched off
 * (`EXPO_NO_DOTENV`): a developer's `.env.local` must not leak into a release bundle, or into a
 * native config value that would also move the cache key away from CI's.
 */
export declare function buildEnv(config: ResolvedConfig, variant: ResolvedVariant): NodeJS.ProcessEnv;
/** KEY=VALUE lines of a dotenv file (quotes stripped, comments ignored). */
export declare function readEnvFile(path: string): Record<string, string>;
/** The fingerprint sources that differ between `previous` and `sources`, as one line. */
export declare function describeChanges(variant: string, previous: CacheMeta | null, sources: CacheMeta["sources"]): string;
