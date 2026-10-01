/**
 * Cache lookup order: this machine first, then the shared remote.
 *
 * A remote hit is copied into the local store before use, so the next build on this machine (or
 * a retry after a CI `--cache-only` step) is a local hit. A remote that is down or
 * unauthenticated is a note, never a failure: the build just runs.
 */
export async function lookup(key, local, remotes, events = {}) {
    const notes = [];
    const own = await local.get(key);
    events.localDone?.(own !== null);
    if (own)
        return { hit: true, source: local.name, entry: own, notes };
    for (const remote of remotes) {
        let found;
        events.remoteStart?.(remote);
        try {
            found = await remote.get(key);
        }
        catch (error) {
            const reason = `${remote.name} unavailable (${describe(error)}); continuing without it`;
            notes.push(reason);
            events.remoteFailed?.(remote, reason);
            continue;
        }
        events.remoteDone?.(remote, found !== null && found.meta.key === key);
        if (!found)
            continue;
        if (found.meta.key !== key) {
            notes.push(`${remote.name} returned an entry for ${found.meta.key}, not ${key}; ignoring it`);
            continue;
        }
        const stored = await local.put(found.meta, found.apkPath);
        return { hit: true, source: remote.name, entry: stored, notes };
    }
    return { hit: false, notes };
}
export function describe(error) {
    if (error instanceof Error)
        return error.message.split("\n")[0] ?? error.name;
    return String(error);
}
