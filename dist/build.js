/**
 * One build: fingerprint → lookup (local, then remote) → reuse / swap, or a full build that then
 * fills the cache. Reports phases through a {@link Reporter}; prints nothing itself.
 */
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { capture, log, onPath, run } from "./exec.js";
import { nativeFingerprint, resolveToolchain } from "./fingerprint.js";
import { createGithubStore } from "./github-store.js";
import { fullBuild } from "./gradle-build.js";
import { cacheKey, keyMaterial } from "./key.js";
import { createLocalStore, defaultCacheDir, sha256File } from "./local-store.js";
import { describe, lookup } from "./lookup.js";
import { META_SCHEMA } from "./meta.js";
import { phase } from "./reporter.js";
import { swapJsIntoApk } from "./swap.js";
export async function runBuild(config, options, reporter) {
    const startedAt = Date.now();
    const { variant } = options;
    const appDir = config.appDir;
    const env = buildEnv(config, variant);
    // The fingerprint evaluates the app config in-process, so it must see the build's env too.
    Object.assign(process.env, env);
    const toolchain = resolveToolchain(appDir);
    const { key, fingerprint } = await phase(reporter, "fingerprint", "Fingerprint native inputs", async () => {
        const fp = await nativeFingerprint(appDir);
        const inputs = {
            fingerprint: fp.hash,
            variant: variant.name,
            abi: config.abi,
            hermesCompiler: toolchain.hermesCompiler,
            reactNative: toolchain.reactNative,
            extras: config.keyExtras,
        };
        if (options.explain)
            log(`key material:\n${keyMaterial(inputs)}`);
        return { key: cacheKey(inputs), fingerprint: fp };
    }, (value) => value.key);
    const cacheDir = config.local.dir ?? defaultCacheDir();
    const local = createLocalStore(cacheDir);
    const workDir = join(cacheDir, ".work", String(process.pid));
    const remote = options.remote && config.remote.enabled && onPath("gh")
        ? createGithubStore({
            cwd: config.root,
            workDir,
            tag: config.remote.tag,
            repo: config.remote.repo,
        })
        : null;
    // Lookup: this machine first, then the shared remote (a remote hit is copied into the local
    // store). A remote that is down or unauthenticated is a note, never a failure.
    let entry = null;
    let source = null;
    if (options.cache) {
        reporter.start("lookup-local", "Local cache");
        let remoteMissed = false;
        const result = await lookup(key, local, remote ? [remote] : [], {
            localDone: (hit) => reporter.done("lookup-local", hit ? "hit" : "miss"),
            remoteStart: (store) => reporter.start("lookup-remote", store.name),
            remoteDone: (_store, hit) => {
                if (hit)
                    reporter.done("lookup-remote", "hit (downloaded)");
                else
                    remoteMissed = true;
            },
            remoteFailed: (_store, reason) => reporter.fail("lookup-remote", reason),
        });
        if (result.hit) {
            entry = result.entry;
            source = result.source;
            if (result.source === local.name)
                reporter.skip("lookup-remote", "local hit");
        }
        else if (remote && remoteMissed) {
            reporter.done("lookup-remote", `miss — ${await explainMiss(remote, variant.name, fingerprint.sources)}`);
        }
        else if (!remote) {
            reporter.skip("lookup-remote", options.remote && config.remote.enabled ? "gh is not on PATH" : "disabled");
        }
    }
    else {
        reporter.skip("lookup-local", "--no-cache");
        reporter.skip("lookup-remote", "--no-cache");
    }
    const outPath = resolve(options.out ??
        join(appDir, "android", "app", "build", "outputs", "rn-build-cache", `${variant.name}.apk`));
    await mkdir(dirname(outPath), { recursive: true });
    let outcome = null;
    let fallbackReason = null;
    if (entry && !variant.embedsJs) {
        await copyFile(entry.apkPath, outPath);
        outcome = "hit";
    }
    else if (entry) {
        await prepare(config, variant, options.prepare, env, reporter);
        const swap = await swapJsIntoApk({
            appDir,
            toolchain,
            meta: entry.meta,
            cachedApk: entry.apkPath,
            workDir,
            outPath,
            env,
            signing: config.signing,
            reporter,
        });
        if (swap.ok)
            outcome = "swap";
        else {
            fallbackReason = swap.reason;
            log(`cannot reuse ${key}: ${swap.reason} — a full build is needed`);
        }
    }
    const finish = (result) => ({
        ...result,
        elapsedMs: Date.now() - startedAt,
    });
    if (outcome !== null) {
        await local.prune(config.local.keep, key);
        return finish({
            outcome,
            key,
            apkPath: outPath,
            source,
            baselineSeconds: entry?.meta.buildSeconds ?? null,
            fallbackReason,
        });
    }
    if (options.cacheOnly) {
        return finish({
            outcome: "none",
            key,
            apkPath: null,
            source,
            baselineSeconds: null,
            fallbackReason,
        });
    }
    if (variant.embedsJs)
        await prepare(config, variant, options.prepare, env, reporter);
    const buildStart = Date.now();
    const built = await fullBuild({
        appDir,
        abi: config.abi,
        prebuild: config.prebuild,
        toolchain,
        variant,
        env,
        reporter,
    });
    const buildSeconds = Math.round((Date.now() - buildStart) / 1000);
    await copyFile(built.apkPath, outPath);
    const meta = {
        schema: META_SCHEMA,
        key,
        variant: variant.name,
        abi: config.abi,
        fingerprint: fingerprint.hash,
        commit: gitHead(config.root),
        builtAt: new Date().toISOString(),
        buildSeconds,
        apkSha256: await sha256File(outPath),
        apkBytes: (await stat(outPath)).size,
        assets: built.assets,
        hbcVersion: built.hbcVersion,
        sources: fingerprint.sources,
    };
    await phase(reporter, "store", "Store in the local cache", async () => {
        await local.put(meta, outPath);
        const pruned = await local.prune(config.local.keep, key);
        return pruned.length > 0 ? `pruned ${pruned.length} old entries` : undefined;
    }, (detail) => detail);
    if (!remote) {
        reporter.skip("upload", "remote cache disabled or unavailable");
    }
    else if (!options.upload) {
        reporter.skip("upload", "pass --upload to share a local build (CI uploads by default)");
    }
    else {
        reporter.start("upload", `Upload to ${remote.name}`);
        try {
            await remote.put(meta, outPath);
            const pruned = await remote.prune(config.remote.keepPerVariant);
            reporter.done("upload", pruned.length > 0 ? `pruned ${pruned.length} old assets` : undefined);
        }
        catch (error) {
            // The build itself is fine; the next build just misses.
            reporter.fail("upload", describe(error));
        }
    }
    return finish({
        outcome: "miss",
        key,
        apkPath: outPath,
        source: null,
        baselineSeconds: null,
        fallbackReason,
    });
}
/**
 * The env every step sees: the variant's defaults, then its env file, then the caller's
 * environment, then the variant's fixed `env`. In an Expo app `.env*` loading is switched off
 * (`EXPO_NO_DOTENV`): a developer's `.env.local` must not leak into a release bundle, or into a
 * native config value that would also move the cache key away from CI's.
 */
export function buildEnv(config, variant) {
    const fromFile = variant.envFile ? readEnvFile(resolve(config.appDir, variant.envFile)) : {};
    const env = {
        ...variant.envDefaults,
        ...fromFile,
        ...process.env,
        ...variant.env,
    };
    if (config.prebuild)
        env.EXPO_NO_DOTENV = "1";
    env.EXPO_NO_TELEMETRY = "1";
    return env;
}
/** KEY=VALUE lines of a dotenv file (quotes stripped, comments ignored). */
export function readEnvFile(path) {
    if (!existsSync(path))
        return {};
    const out = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (match?.[1] && match[2] !== undefined) {
            out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
        }
    }
    return out;
}
async function prepare(config, variant, force, env, reporter) {
    if (variant.prepare.length === 0) {
        reporter.skip("prepare", "no prepare steps configured");
        return;
    }
    await phase(reporter, "prepare", "Prepare workspace", async () => {
        let ran = 0;
        for (const step of variant.prepare) {
            if (!force && step.unlessExists && existsSync(resolve(config.root, step.unlessExists)))
                continue;
            const [command, ...args] = step.run;
            if (!command)
                continue;
            await run(command, args, { cwd: config.root, env });
            ran++;
        }
        return `${ran}/${variant.prepare.length} steps`;
    }, (detail) => detail);
}
/** On a miss, name the fingerprint sources that moved since the newest shared entry. */
async function explainMiss(remote, variant, sources) {
    try {
        const previous = await remote.newestMeta(variant);
        if (!previous)
            return `no shared ${variant} entry yet`;
        const before = new Map(previous.sources.map((s) => [s.id, s.hash]));
        const after = new Map(sources.map((s) => [s.id, s.hash]));
        const moved = [...new Set([...before.keys(), ...after.keys()])].filter((id) => before.get(id) !== after.get(id));
        return moved.length > 0
            ? `${moved.length} sources changed since ${previous.commit}: ${moved.slice(0, 5).join(", ")}`
            : `same fingerprint as ${previous.commit}; toolchain, ABI or key extras changed`;
    }
    catch (error) {
        return `could not compare with the newest entry (${describe(error)})`;
    }
}
function gitHead(cwd) {
    try {
        return capture("git", ["rev-parse", "--short=8", "HEAD"], { cwd });
    }
    catch {
        return "unknown";
    }
}
