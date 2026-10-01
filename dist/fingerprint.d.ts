/**
 * The native fingerprint of the app, and the toolchain the app itself resolves.
 *
 * `@expo/fingerprint` is loaded from the APP's dependency tree (directly, or through `expo`), not
 * bundled with this tool: its hash must be the one the project's own Expo version computes.
 *
 * Taken on the committed tree, BEFORE prebuild: prebuild rewrites tracked android/ files for the
 * flavor, so a fingerprint taken after it would move between the lookup and the store. A clean CI
 * checkout and a clean local checkout therefore agree; a locally modified android/ only produces a
 * different key (a miss), never a wrong hit.
 */
import type { FingerprintSourceSummary } from "./meta.js";
export interface NativeFingerprint {
    readonly hash: string;
    readonly sources: FingerprintSourceSummary[];
}
/**
 * `extra` is skipped because apps commonly stamp the commit and build time into it, which would
 * change the hash on every commit. It is not native: it reaches the app as `assets/app.config`,
 * which the release swap regenerates. Package scripts cannot change the native build.
 *
 * Reads `process.env` through the app config, so the build's env must be set first.
 */
export declare function nativeFingerprint(appDir: string): Promise<NativeFingerprint>;
export interface Toolchain {
    readonly reactNative: string;
    /** The Hermes compiler's version (hermes-compiler, or react-native's bundled one). */
    readonly hermesCompiler: string;
    readonly hermesc: string;
    /** react-native's CLI entry, for bare apps' `bundle`. */
    readonly reactNativeCli: string;
    /** `@expo/cli`, as the Gradle plugin of an Expo app resolves it. Null in a bare app. */
    readonly expoCli: string | null;
    /** expo-constants' dir (it regenerates `assets/app.config`). Null when not installed. */
    readonly expoConstantsDir: string | null;
}
export declare function resolveToolchain(appDir: string): Toolchain;
