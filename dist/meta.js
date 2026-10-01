/**
 * What a cache entry records beside its APK (`<key>.json`).
 *
 * Uploaded after the APK, so a remote entry whose JSON exists is complete.
 */
export const META_SCHEMA = 1;
export function parseMeta(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (typeof raw !== "object" || raw === null)
        return null;
    const meta = raw;
    if (meta.schema !== META_SCHEMA)
        return null;
    if (typeof meta.key !== "string" || typeof meta.apkSha256 !== "string")
        return null;
    if (typeof meta.buildSeconds !== "number" || !Array.isArray(meta.sources))
        return null;
    return meta;
}
