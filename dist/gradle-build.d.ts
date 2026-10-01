/**
 * The cache-miss path: optional `expo prebuild`, then the full Gradle build.
 *
 * Ordering matters: everything the caller needs from the build (the APK, the emitted asset
 * hashes, the bundle's bytecode version) is copied or read BEFORE android/ is restored after
 * prebuild. The restore itself only reverts tracked files and deletes the untracked, non-ignored
 * files prebuild created — never ignored build output.
 */
import type { ResolvedVariant } from "./config.js";
import type { Toolchain } from "./fingerprint.js";
import type { Reporter } from "./reporter.js";
export interface FullBuildResult {
    /** `outPath`: the APK, already copied out of android/. */
    readonly apkPath: string;
    readonly assets: Record<string, string> | null;
    readonly hbcVersion: number | null;
}
/** The two external steps, injectable for tests. */
export interface BuildSteps {
    prebuild(appDir: string, env: NodeJS.ProcessEnv): Promise<void>;
    gradle(androidDir: string, args: string[], env: NodeJS.ProcessEnv): Promise<void>;
}
export declare function defaultSteps(toolchain: Toolchain): BuildSteps;
export declare function fullBuild(options: {
    readonly appDir: string;
    readonly abi: string;
    readonly prebuild: boolean;
    readonly toolchain: Toolchain;
    readonly variant: ResolvedVariant;
    readonly env: NodeJS.ProcessEnv;
    readonly reporter: Reporter;
    /** Where the APK is copied before android/ is restored. */
    readonly outPath: string;
    readonly steps?: BuildSteps;
    /** Seconds to wait before Gradle retry n (tests pass 0). */
    readonly retryDelaySeconds?: number;
}): Promise<FullBuildResult>;
/**
 * Reverts tracked files under `path` and deletes the untracked, NON-ignored files there (what a
 * prebuild adds), then any directories that leaves empty. Ignored files — Gradle's build/, .cxx/,
 * local.properties — are never touched.
 */
export declare function restoreTree(gitRoot: string, path: string): void;
/** `ccache --print-stats` counters as "hits/total". */
export declare function ccacheSummary(stats: string): string;
/**
 * ccache for React Native's C++ through CMake's compiler launcher: AGP's CMake tasks are not
 * cacheable by Gradle, so without it every build recompiles every translation unit. Values the
 * caller already set win.
 */
export declare function withCcache(env: NodeJS.ProcessEnv, baseDir: string): NodeJS.ProcessEnv;
