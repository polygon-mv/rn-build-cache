/**
 * One build: fingerprint → lookup (local, then remote) → reuse / swap, or a full build that then
 * fills the cache. Reports phases through a {@link Reporter}; prints nothing itself.
 */
import type { ResolvedConfig, ResolvedVariant } from "./config.js";
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
/**
 * The env every step sees: the variant's defaults, then its env file, then the caller's
 * environment, then the variant's fixed `env`. In an Expo app `.env*` loading is switched off
 * (`EXPO_NO_DOTENV`): a developer's `.env.local` must not leak into a release bundle, or into a
 * native config value that would also move the cache key away from CI's.
 */
export declare function buildEnv(config: ResolvedConfig, variant: ResolvedVariant): NodeJS.ProcessEnv;
/** KEY=VALUE lines of a dotenv file (quotes stripped, comments ignored). */
export declare function readEnvFile(path: string): Record<string, string>;
