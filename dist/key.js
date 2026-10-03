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
import { createHash } from "node:crypto";
export const RECIPE_VERSION = 1;
/** Stable, order-independent serialisation of the inputs (exported for tests and `--explain`). */
export function keyMaterial(inputs) {
    const fields = {
        abi: inputs.abi,
        buildType: inputs.buildType,
        fingerprint: inputs.fingerprint,
        hermesCompiler: inputs.hermesCompiler,
        reactNative: inputs.reactNative,
        recipe: String(inputs.recipe ?? RECIPE_VERSION),
        variant: inputs.variant,
    };
    for (const [name, value] of Object.entries(inputs.extras ?? {}))
        fields[`extra.${name}`] = value;
    for (const [name, value] of Object.entries(fields)) {
        if (value.trim() === "")
            throw new Error(`cache key input "${name}" is empty`);
    }
    return Object.keys(fields)
        .sort()
        .map((name) => `${name}=${fields[name]}`)
        .join("\n");
}
/**
 * `<variant>-<24 hex>`. The variant prefix keeps asset names readable in the release and lets
 * pruning group entries without downloading metadata.
 */
export function cacheKey(inputs) {
    const digest = createHash("sha256").update(keyMaterial(inputs)).digest("hex").slice(0, 24);
    return `${inputs.variant}-${digest}`;
}
/** The variant a key belongs to, or null for a name this tool did not produce. */
export function variantOfKey(key) {
    const match = /^([a-z]+)-[0-9a-f]{24}$/.exec(key);
    return match?.[1] ?? null;
}
