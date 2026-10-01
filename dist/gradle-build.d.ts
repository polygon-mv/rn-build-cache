/**
 * The cache-miss path: optional `expo prebuild`, then the full Gradle build.
 */
import type { ResolvedVariant } from "./config.js";
import type { Toolchain } from "./fingerprint.js";
import type { Reporter } from "./reporter.js";
export interface FullBuildResult {
    readonly apkPath: string;
    readonly assets: Record<string, string> | null;
    readonly hbcVersion: number | null;
}
export declare function fullBuild(options: {
    readonly appDir: string;
    readonly abi: string;
    readonly prebuild: boolean;
    readonly toolchain: Toolchain;
    readonly variant: ResolvedVariant;
    readonly env: NodeJS.ProcessEnv;
    readonly reporter: Reporter;
}): Promise<FullBuildResult>;
/** `cacheable_call`-style counters from `ccache --print-stats` as "hits/total". */
export declare function ccacheSummary(stats: string): string;
/**
 * ccache for React Native's C++ through CMake's compiler launcher: AGP's CMake tasks are not
 * cacheable by Gradle, so without it every build recompiles every translation unit. Values the
 * caller already set win.
 */
export declare function withCcache(env: NodeJS.ProcessEnv, baseDir: string): NodeJS.ProcessEnv;
