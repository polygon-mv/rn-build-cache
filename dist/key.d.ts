/**
 * The cache key: which cached APK may stand in for a fresh Gradle build.
 *
 * The Expo fingerprint covers the native inputs (android/, config plugins, autolinked modules, the
 * evaluated app config). It does not know about things that live outside the project but still
 * change the binary, so those are folded in here:
 *
 * - `variant`: flavors are often switched by env (e.g. `APP_ENV`) rather than Gradle flavors, and
 *   two flavors' configs may differ only in fields the fingerprint happens not to cover.
 * - `buildType`: a variant moved from `debug` to `debugOptimized` (or `release`) keeps its name and
 *   often its fingerprint, but its APK is a different binary.
 * - `abi`: an arm64-only APK must never answer for a universal one.
 * - `hermesCompiler`: a swapped bundle is compiled by `hermes-compiler` from node_modules and must
 *   match the bytecode version of the Hermes runtime inside the cached APK.
 * - `recipe`: bumped whenever this tool changes how it builds or what goes into an entry.
 * - `extras`: the project's own `keyExtras` (Gradle flags, anything else it wants to key on).
 */
export declare const RECIPE_VERSION = 1;
export interface KeyInputs {
    readonly fingerprint: string;
    readonly variant: string;
    readonly buildType: string;
    readonly abi: string;
    readonly hermesCompiler: string;
    readonly reactNative: string;
    readonly extras?: Readonly<Record<string, string>>;
    readonly recipe?: number;
}
/** Stable, order-independent serialisation of the inputs (exported for tests and `--explain`). */
export declare function keyMaterial(inputs: KeyInputs): string;
/**
 * `<variant>-<24 hex>`. The variant prefix keeps asset names readable in the release and lets
 * pruning group entries without downloading metadata.
 */
export declare function cacheKey(inputs: KeyInputs): string;
/** The variant a key belongs to, or null for a name this tool did not produce. */
export declare function variantOfKey(key: string): string | null;
