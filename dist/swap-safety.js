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
/** `HBC` file magic, little-endian on disk: c6 1f bc 03 c1 03 19 1f. */
const HBC_MAGIC = 0x1f1903c103bc1fc6n;
/** The bytecode version from a Hermes bundle header, or null when it is not Hermes bytecode. */
export function hbcVersion(header) {
    if (header.byteLength < 12)
        return null;
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (view.getBigUint64(0, true) !== HBC_MAGIC)
        return null;
    return view.getUint32(8, true);
}
export function diffAssets(fresh, cached) {
    const added = [];
    const changed = [];
    for (const [path, hash] of Object.entries(fresh)) {
        if (!(path in cached))
            added.push(path);
        else if (cached[path] !== hash)
            changed.push(path);
    }
    const removed = Object.keys(cached).filter((path) => !(path in fresh));
    return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}
export function decideSwap(meta, fresh) {
    if (meta.assets === null) {
        return {
            safe: false,
            reason: "the cache entry has no asset manifest, so its asset set cannot be proven to match",
        };
    }
    if (meta.hbcVersion === null || fresh.hbcVersion === null) {
        return { safe: false, reason: "the Hermes bytecode version of one side is unknown" };
    }
    if (meta.hbcVersion !== fresh.hbcVersion) {
        return {
            safe: false,
            reason: `Hermes bytecode v${fresh.hbcVersion} does not match the cached APK's v${meta.hbcVersion}`,
        };
    }
    const diff = diffAssets(fresh.assets, meta.assets);
    const total = diff.added.length + diff.removed.length + diff.changed.length;
    if (total > 0) {
        const example = [...diff.added, ...diff.changed, ...diff.removed][0];
        return {
            safe: false,
            reason: `the JS asset set differs from the cached APK's (${diff.added.length} added, ` +
                `${diff.changed.length} changed, ${diff.removed.length} removed; e.g. ${example}) — ` +
                `assets live in res/, which only a Gradle build can change`,
        };
    }
    return { safe: true };
}
