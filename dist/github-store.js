/**
 * The shared remote cache: assets on ONE GitHub release (default tag `native-build-cache`).
 *
 * One release rather than one per fingerprint: a new entry per native change would push real
 * releases down the list. This one is created once and sinks below them as they are published —
 * exactly what an internal store wants. Release assets are not billed storage, and `gh` reaches
 * them from CI and from a laptop alike (Actions cache is CI-only and branch-scoped).
 *
 * An entry is `<key>.apk` + `<key>.json`; the JSON is uploaded last, so it marks a complete entry.
 */
import { copyFile, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { capture, log } from "./exec.js";
import { variantOfKey } from "./key.js";
import { sha256File } from "./local-store.js";
import { parseMeta } from "./meta.js";
const RELEASE_TITLE = "Native build cache (internal, not for testers)";
const RELEASE_NOTES = `Internal store for [rn-build-cache](https://github.com/polygon-mv/rn-build-cache).

Each \`<variant>-<key>.apk\` is a native build keyed by its Expo fingerprint; the matching \`.json\`
says what it was built from. Assets here are pruned automatically; deleting the whole release only
costs one rebuild per variant.`;
export function createGithubStore(options) {
    const tag = options.tag;
    const repoArgs = options.repo ? ["--repo", options.repo] : [];
    const gh = ([verb, sub, ...rest]) => capture("gh", [verb, sub, ...repoArgs, ...rest], { cwd: options.cwd });
    /** Assets on the release, or null when the release does not exist yet. */
    const listAssets = () => {
        try {
            const out = gh(["release", "view", tag, "--json", "assets"]);
            return JSON.parse(out).assets;
        }
        catch (error) {
            if (/release not found|not found/i.test(String(error)))
                return null;
            throw error;
        }
    };
    const download = async (names, dir) => {
        await mkdir(dir, { recursive: true });
        const patterns = names.flatMap((name) => ["--pattern", name]);
        await withRetry(() => gh(["release", "download", tag, ...patterns, "--dir", dir, "--clobber"]));
    };
    const readMeta = async (key) => {
        const dir = join(options.workDir, "download");
        await download([`${key}.json`], dir);
        return parseMeta(await readFile(join(dir, `${key}.json`), "utf8"));
    };
    return {
        name: `GitHub release ${options.repo ? `${options.repo}@` : ""}${tag}`,
        async get(key) {
            const assets = listAssets();
            const names = new Set(assets?.map((asset) => asset.name) ?? []);
            if (!names.has(`${key}.json`) || !names.has(`${key}.apk`))
                return null;
            const dir = join(options.workDir, "download");
            const meta = await readMeta(key);
            if (!meta)
                throw new Error(`${key}.json on the release is not a cache entry this tool reads`);
            log(`downloading ${key}.apk (${(meta.apkBytes / 1e6).toFixed(0)} MB) from the release`);
            await download([`${key}.apk`], dir);
            const apkPath = join(dir, `${key}.apk`);
            const actual = await sha256File(apkPath);
            if (actual !== meta.apkSha256) {
                await rm(apkPath, { force: true });
                throw new Error(`${key}.apk does not match its recorded sha256 (download corrupted?)`);
            }
            return { meta, apkPath };
        },
        async put(meta, apkPath) {
            if (listAssets() === null) {
                try {
                    gh([
                        "release",
                        "create",
                        tag,
                        "--prerelease",
                        "--latest=false",
                        "--title",
                        RELEASE_TITLE,
                        "--notes",
                        RELEASE_NOTES,
                    ]);
                }
                catch (error) {
                    // Two builds racing to create it: the loser just uploads into the winner's release.
                    if (!/already exists/i.test(String(error)))
                        throw error;
                }
            }
            const dir = join(options.workDir, "upload");
            await rm(dir, { recursive: true, force: true });
            await mkdir(dir, { recursive: true });
            // The asset name is the file's basename, so give the APK its key as a name (a hard link,
            // not a 100 MB copy).
            const apk = join(dir, `${meta.key}.apk`);
            await link(apkPath, apk).catch(() => copyFile(apkPath, apk));
            const json = join(dir, `${meta.key}.json`);
            await writeFile(json, JSON.stringify(meta, null, 2));
            await withRetry(() => gh(["release", "upload", tag, apk, "--clobber"]));
            await withRetry(() => gh(["release", "upload", tag, json, "--clobber"]));
            await rm(dir, { recursive: true, force: true });
        },
        async prune(keepPerVariant) {
            const assets = listAssets() ?? [];
            const doomed = entriesToPrune(assets, keepPerVariant);
            for (const name of doomed) {
                try {
                    gh(["release", "delete-asset", tag, name, "--yes"]);
                }
                catch (error) {
                    log(`could not prune ${name}: ${String(error)}`);
                }
            }
            return doomed;
        },
        async newestMeta(variant) {
            const assets = listAssets() ?? [];
            const newest = assets
                .filter((asset) => asset.name.endsWith(".json"))
                .filter((asset) => variantOfKey(asset.name.slice(0, -".json".length)) === variant)
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
            return newest ? readMeta(newest.name.slice(0, -".json".length)) : null;
        },
    };
}
/**
 * Asset names to delete so each variant keeps its `keep` newest entries. An entry's age is its
 * JSON's upload time; an APK without a JSON (an interrupted upload) is always removed.
 */
export function entriesToPrune(assets, keep) {
    const byKey = new Map();
    for (const asset of assets) {
        const match = /^(.+)\.(apk|json)$/.exec(asset.name);
        const key = match?.[1];
        if (!key || variantOfKey(key) === null)
            continue;
        const slot = byKey.get(key) ?? {};
        if (match?.[2] === "apk")
            slot.apk = asset;
        else
            slot.json = asset;
        byKey.set(key, slot);
    }
    const doomed = [];
    const complete = new Map();
    for (const [key, slot] of byKey) {
        if (!slot.json) {
            // Orphan APK; leave a very fresh one alone, it may be another build mid-upload.
            if (slot.apk && Date.now() - Date.parse(slot.apk.createdAt) > 60 * 60 * 1000) {
                doomed.push(slot.apk.name);
            }
            continue;
        }
        const variant = variantOfKey(key);
        const list = complete.get(variant) ?? [];
        list.push({ key, at: slot.json.createdAt });
        complete.set(variant, list);
    }
    for (const list of complete.values()) {
        list.sort((a, b) => b.at.localeCompare(a.at));
        for (const { key } of list.slice(keep)) {
            const slot = byKey.get(key);
            if (slot?.apk)
                doomed.push(slot.apk.name);
            if (slot?.json)
                doomed.push(slot.json.name);
        }
    }
    return doomed;
}
async function withRetry(step, attempts = 3) {
    for (let attempt = 1;; attempt++) {
        try {
            return step();
        }
        catch (error) {
            if (attempt >= attempts)
                throw error;
            log(`GitHub call failed (attempt ${attempt}); retrying in ${10 * attempt}s`);
            await new Promise((resolve) => setTimeout(resolve, 10_000 * attempt));
        }
    }
}
