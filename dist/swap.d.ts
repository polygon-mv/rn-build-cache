/**
 * Puts the current commit's JS into a COPY of a cached release APK, exactly where Gradle would.
 *
 * Up to three APK entries change per commit, and each one present in the cached APK is rewritten:
 *
 * - `assets/index.android.bundle`: bundled the way the RN Gradle plugin does it (`export:embed` in
 *   an Expo app, `react-native bundle` otherwise, with `--minify false` and, unless the variant
 *   opts out, `--reset-cache`), compiled
 *   with `hermesc -emit-binary -O`, and stored uncompressed as AGP stores it so Hermes can mmap it.
 * - `assets/app.config` (expo-constants): the serialised app config, including `extra`, which the
 *   fingerprint deliberately ignores.
 * - `assets/app.manifest` (expo-updates): the embedded update manifest. Its `id` must be NEW: the
 *   embedded loader copies the embedded update into its own store keyed by that id, so a device
 *   that ran the previous APK would otherwise keep launching the previous JS. The asset list is
 *   carried over, which is only correct because {@link decideSwap} proved the asset set unchanged.
 *
 * Then `zipalign -P 16` (16 KB pages for the `.so` files) and `apksigner`. Re-signing with the key
 * the release build type uses keeps the result installable over a Gradle-built APK.
 */
import type { Toolchain } from "./fingerprint.js";
import type { CacheMeta } from "./meta.js";
import type { Reporter } from "./reporter.js";
export type SwapResult = {
    readonly ok: true;
    readonly apkPath: string;
} | {
    readonly ok: false;
    readonly reason: string;
};
export interface Signing {
    readonly keystore: string;
    readonly storePassword: string;
    readonly keyAlias: string;
    readonly keyPassword: string;
}
export interface SwapOptions {
    readonly appDir: string;
    readonly toolchain: Toolchain;
    readonly meta: CacheMeta;
    readonly cachedApk: string;
    readonly workDir: string;
    readonly outPath: string;
    readonly env: NodeJS.ProcessEnv;
    readonly signing: Signing;
    /** `--reset-cache` for Metro; false reuses its transform cache. */
    readonly resetMetroCache?: boolean;
    readonly reporter: Reporter;
}
export declare function swapJsIntoApk(options: SwapOptions): Promise<SwapResult>;
/**
 * Replaces `entries` (staged under `stage`) in a copy of `cachedApk`, then aligns and signs it into
 * `outPath`. Throws on any failed step.
 */
export declare function repackApk(options: {
    readonly stage: string;
    readonly entries: readonly string[];
    readonly cachedApk: string;
    readonly outPath: string;
    readonly signing: Signing;
    readonly tools: BuildTools;
}): Promise<void>;
/** sha256 of every file under `dir`, by path relative to it. Empty when `dir` does not exist. */
export declare function hashTree(dir: string): Promise<Record<string, string>>;
export declare function readHbcVersion(path: string): Promise<number | null>;
/** Reads the bundle header straight out of an APK. */
export declare function apkHbcVersion(apkPath: string): number | null;
export interface BuildTools {
    readonly zipalign: string;
    readonly apksigner: string;
    readonly major: number;
}
/** The newest SDK build-tools that has both zipalign and apksigner. */
export declare function findBuildTools(): BuildTools | null;
export declare function compareDotted(a: string, b: string): number;
