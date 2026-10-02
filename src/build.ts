/**
 * One build: fingerprint → lookup (local, then remote) → reuse / swap, or a full build that then
 * fills the cache. Reports phases through a {@link Reporter}; prints nothing itself.
 */

import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ResolvedConfig, ResolvedVariant } from "./config.js";
import { capture, log, onPath, run } from "./exec.js";
import { nativeFingerprint, resolveToolchain } from "./fingerprint.js";
import { createGithubStore, type GithubStore } from "./github-store.js";
import { fullBuild } from "./gradle-build.js";
import { cacheKey, keyMaterial, type KeyInputs } from "./key.js";
import { createLocalStore, defaultCacheDir, sha256File } from "./local-store.js";
import { describe, lookup, type CacheEntry } from "./lookup.js";
import { META_SCHEMA, type CacheMeta } from "./meta.js";
import { phase, type Reporter } from "./reporter.js";
import { swapJsIntoApk } from "./swap.js";

export interface BuildOptions {
  readonly variant: ResolvedVariant;
  readonly cache: boolean;
  readonly remote: boolean;
  readonly upload: boolean;
  readonly cacheOnly: boolean;
  readonly prepare: boolean;
  readonly out: string | null;
  readonly explain: boolean;
}

export type Outcome = "hit" | "swap" | "miss" | "none";

export interface BuildResult {
  readonly outcome: Outcome;
  readonly key: string;
  readonly apkPath: string | null;
  /** Where a hit came from. */
  readonly source: string | null;
  /** Wall time of the build that produced the reused entry, for "time saved". */
  readonly baselineSeconds: number | null;
  /** Why a cached entry could not be used, when it could not. */
  readonly fallbackReason: string | null;
  readonly elapsedMs: number;
}

export async function runBuild(
  config: ResolvedConfig,
  options: BuildOptions,
  reporter: Reporter,
): Promise<BuildResult> {
  const startedAt = Date.now();
  const { variant } = options;
  const { env, toolchain, key, fingerprint } = await fingerprintVariant(
    config,
    variant,
    options.explain,
    reporter,
  );
  const appDir = config.appDir;

  const { local, workDir, remote } = stores(config, options.remote);

  // Lookup: this machine first, then the shared remote (a remote hit is copied into the local
  // store). A remote that is down or unauthenticated is a note, never a failure.
  let entry: CacheEntry | null = null;
  let source: string | null = null;
  if (options.cache) {
    reporter.start("lookup-local", "Local cache");
    let remoteMissed = false;
    const result = await lookup(key, local, remote ? [remote] : [], {
      localDone: (hit) => reporter.done("lookup-local", hit ? "hit" : "miss"),
      remoteStart: (store) => reporter.start("lookup-remote", store.name),
      remoteDone: (_store, hit) => {
        if (hit) reporter.done("lookup-remote", "hit (downloaded)");
        else remoteMissed = true;
      },
      remoteFailed: (_store, reason) => reporter.fail("lookup-remote", reason),
    });
    if (result.hit) {
      entry = result.entry;
      source = result.source;
      if (result.source === local.name) reporter.skip("lookup-remote", "local hit");
    } else if (remote && remoteMissed) {
      reporter.done(
        "lookup-remote",
        `miss — ${await explainMiss(remote, variant.name, fingerprint.sources)}`,
      );
    } else if (!remote) {
      reporter.skip(
        "lookup-remote",
        options.remote && config.remote.enabled ? "gh is not on PATH" : "disabled",
      );
    }
  } else {
    reporter.skip("lookup-local", "--no-cache");
    reporter.skip("lookup-remote", "--no-cache");
  }

  const outPath = resolve(
    options.out ??
      join(appDir, "android", "app", "build", "outputs", "rn-build-cache", `${variant.name}.apk`),
  );
  await mkdir(dirname(outPath), { recursive: true });

  let outcome: Outcome | null = null;
  let fallbackReason: string | null = null;
  if (entry && !variant.embedsJs) {
    await copyFile(entry.apkPath, outPath);
    outcome = "hit";
  } else if (entry) {
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
      resetMetroCache: variant.resetMetroCache,
      reporter,
    });
    if (swap.ok) outcome = "swap";
    else {
      fallbackReason = swap.reason;
      log(`cannot reuse ${key}: ${swap.reason} — a full build is needed`);
    }
  }

  const finish = (result: Omit<BuildResult, "elapsedMs">): BuildResult => ({
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

  if (variant.embedsJs) await prepare(config, variant, options.prepare, env, reporter);
  const buildStart = Date.now();
  const built = await fullBuild({
    appDir,
    abi: config.abi,
    prebuild: config.prebuild,
    toolchain,
    variant,
    env,
    reporter,
    outPath,
  });
  const buildSeconds = Math.round((Date.now() - buildStart) / 1000);

  const meta: CacheMeta = {
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
  await phase(
    reporter,
    "store",
    "Store in the local cache",
    async () => {
      await local.put(meta, outPath);
      const pruned = await local.prune(config.local.keep, key);
      return pruned.length > 0 ? `pruned ${pruned.length} old entries` : undefined;
    },
    (detail) => detail,
  );

  if (!remote) {
    reporter.skip("upload", "remote cache disabled or unavailable");
  } else if (!options.upload) {
    reporter.skip("upload", "pass --upload to share a local build (CI uploads by default)");
  } else {
    reporter.start("upload", `Upload to ${remote.name}`);
    try {
      await remote.put(meta, outPath);
      const pruned = await remote.prune(config.remote.keepPerVariant);
      reporter.done("upload", pruned.length > 0 ? `pruned ${pruned.length} old assets` : undefined);
    } catch (error) {
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

/** The env, toolchain and cache key of a variant: what every lookup starts from. */
async function fingerprintVariant(
  config: ResolvedConfig,
  variant: ResolvedVariant,
  explain: boolean,
  reporter: Reporter,
) {
  const env = buildEnv(config, variant);
  // The fingerprint evaluates the app config in-process, so it must see the build's env too.
  Object.assign(process.env, env);
  const toolchain = resolveToolchain(config.appDir);
  const { key, fingerprint } = await phase(
    reporter,
    "fingerprint",
    "Fingerprint native inputs",
    async () => {
      const fp = await nativeFingerprint(config.appDir);
      const inputs: KeyInputs = {
        fingerprint: fp.hash,
        variant: variant.name,
        abi: config.abi,
        hermesCompiler: toolchain.hermesCompiler,
        reactNative: toolchain.reactNative,
        extras: config.keyExtras,
      };
      if (explain) log(`key material:\n${keyMaterial(inputs)}`);
      return { key: cacheKey(inputs), fingerprint: fp };
    },
    (value) => value.key,
  );
  return { env, toolchain, key, fingerprint };
}

function stores(config: ResolvedConfig, useRemote: boolean) {
  const cacheDir = config.local.dir ?? defaultCacheDir();
  const local = createLocalStore(cacheDir);
  const workDir = join(cacheDir, ".work", String(process.pid));
  const remote: GithubStore | null =
    useRemote && config.remote.enabled && onPath("gh")
      ? createGithubStore({
          cwd: config.root,
          workDir,
          tag: config.remote.tag,
          repo: config.remote.repo,
        })
      : null;
  return { local, workDir, remote };
}

export interface CheckResult {
  readonly key: string;
  readonly fingerprint: string;
  /** Whether an entry for the key exists: `local`, `remote`, or null. Nothing is downloaded. */
  readonly cachedIn: "local" | "remote" | null;
  /** The newest shared entry of this variant, when the remote is reachable and has one. */
  readonly newest: {
    readonly key: string;
    readonly commit: string;
    readonly builtAt: string;
  } | null;
  /** On a miss: which fingerprint sources moved since the newest shared entry. */
  readonly changes: string | null;
  readonly elapsedMs: number;
}

/**
 * `--check`: would a build of this variant need Gradle? Fingerprints, then asks the local store
 * and the release whether the key exists, without downloading an APK, bundling or building.
 * Cheap enough for a push-triggered job that only decides whether a native build is needed.
 */
export async function runCheck(
  config: ResolvedConfig,
  variant: ResolvedVariant,
  options: { readonly remote: boolean; readonly explain: boolean },
  reporter: Reporter,
): Promise<CheckResult> {
  const startedAt = Date.now();
  const { key, fingerprint } = await fingerprintVariant(config, variant, options.explain, reporter);
  const { local, remote } = stores(config, options.remote);
  let cachedIn: CheckResult["cachedIn"] = null;
  reporter.start("lookup-local", "Local cache");
  const own = await local.get(key);
  reporter.done("lookup-local", own ? "hit" : "miss");
  if (own) cachedIn = "local";

  let newest: CheckResult["newest"] = null;
  let changes: string | null = null;
  if (!remote) {
    reporter.skip(
      "lookup-remote",
      options.remote && config.remote.enabled ? "gh is not on PATH" : "disabled",
    );
  } else {
    reporter.start("lookup-remote", remote.name);
    try {
      const there = await remote.has(key);
      if (there && !cachedIn) cachedIn = "remote";
      const meta = await remote.newestMeta(variant.name);
      if (meta) newest = { key: meta.key, commit: meta.commit, builtAt: meta.builtAt };
      if (!there) changes = describeChanges(variant.name, meta, fingerprint.sources);
      reporter.done("lookup-remote", there ? "has this key" : `miss — ${changes}`);
    } catch (error) {
      reporter.fail("lookup-remote", describe(error));
    }
  }
  return {
    key,
    fingerprint: fingerprint.hash,
    cachedIn,
    newest,
    changes,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * The env every step sees: the variant's defaults, then its env file, then the caller's
 * environment, then the variant's fixed `env`. In an Expo app `.env*` loading is switched off
 * (`EXPO_NO_DOTENV`): a developer's `.env.local` must not leak into a release bundle, or into a
 * native config value that would also move the cache key away from CI's.
 */
export function buildEnv(config: ResolvedConfig, variant: ResolvedVariant): NodeJS.ProcessEnv {
  const fromFile = variant.envFile ? readEnvFile(resolve(config.appDir, variant.envFile)) : {};
  const env: NodeJS.ProcessEnv = {
    ...variant.envDefaults,
    ...fromFile,
    ...process.env,
    ...variant.env,
  };
  if (config.prebuild) env.EXPO_NO_DOTENV = "1";
  env.EXPO_NO_TELEMETRY = "1";
  return env;
}

/** KEY=VALUE lines of a dotenv file (quotes stripped, comments ignored). */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] && match[2] !== undefined) {
      out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return out;
}

async function prepare(
  config: ResolvedConfig,
  variant: ResolvedVariant,
  force: boolean,
  env: NodeJS.ProcessEnv,
  reporter: Reporter,
): Promise<void> {
  if (variant.prepare.length === 0) {
    reporter.skip("prepare", "no prepare steps configured");
    return;
  }
  await phase(
    reporter,
    "prepare",
    "Prepare workspace",
    async () => {
      let ran = 0;
      for (const step of variant.prepare) {
        if (!force && step.unlessExists && existsSync(resolve(config.root, step.unlessExists)))
          continue;
        const [command, ...args] = step.run;
        if (!command) continue;
        await run(command, args, { cwd: config.root, env });
        ran++;
      }
      return `${ran}/${variant.prepare.length} steps`;
    },
    (detail) => detail,
  );
}

/** On a miss, name the fingerprint sources that moved since the newest shared entry. */
async function explainMiss(
  remote: GithubStore,
  variant: string,
  sources: CacheMeta["sources"],
): Promise<string> {
  try {
    return describeChanges(variant, await remote.newestMeta(variant), sources);
  } catch (error) {
    return `could not compare with the newest entry (${describe(error)})`;
  }
}

/** The fingerprint sources that differ between `previous` and `sources`, as one line. */
export function describeChanges(
  variant: string,
  previous: CacheMeta | null,
  sources: CacheMeta["sources"],
): string {
  if (!previous) return `no shared ${variant} entry yet`;
  const before = new Map(previous.sources.map((s) => [s.id, s.hash]));
  const after = new Map(sources.map((s) => [s.id, s.hash]));
  const moved = [...new Set([...before.keys(), ...after.keys()])].filter(
    (id) => before.get(id) !== after.get(id),
  );
  return moved.length > 0
    ? `${moved.length} sources changed since ${previous.commit}: ${moved.slice(0, 5).join(", ")}`
    : `same fingerprint as ${previous.commit}; toolchain, ABI or key extras changed`;
}

function gitHead(cwd: string): string {
  try {
    return capture("git", ["rev-parse", "--short=8", "HEAD"], { cwd });
  } catch {
    return "unknown";
  }
}
