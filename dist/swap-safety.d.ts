/**
 * Whether this commit's JS may be dropped into a cached release APK, or a full build is required.
 *
 * The native fingerprint already rules out native, config and dependency changes (a different key
 * has no entry). What it cannot see is decided here, from the freshly bundled output:
 *
 * - **The JS asset set.** Images and other files a bundle `require`s are compiled by AAPT into
 *   `res/` with shortened paths and a `resources.arsc` row. Only a Gradle build can add, remove or
 *   change one, and a bundle that references an asset the APK lacks fails at runtime.
 * - **The Hermes bytecode version.** The swapped bundle is compiled by node_modules' hermesc; the
 *   runtime in the APK refuses bytecode of another version and the app dies on launch.
 */
import type { CacheMeta } from "./meta.js";
/** The bytecode version from a Hermes bundle header, or null when it is not Hermes bytecode. */
export declare function hbcVersion(header: Uint8Array): number | null;
export interface AssetDiff {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly string[];
}
export declare function diffAssets(fresh: Readonly<Record<string, string>>, cached: Readonly<Record<string, string>>): AssetDiff;
export type SwapDecision = {
    readonly safe: true;
} | {
    readonly safe: false;
    readonly reason: string;
};
export interface FreshBundle {
    readonly assets: Readonly<Record<string, string>>;
    /** Null when hermesc produced no bytecode (it always should for this app). */
    readonly hbcVersion: number | null;
}
export declare function decideSwap(meta: CacheMeta, fresh: FreshBundle): SwapDecision;
