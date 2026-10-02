/**
 * The consuming project's config: `rn-build-cache.config.{mjs,js,json}` (or `.ts` when the runtime
 * can import TypeScript — Bun, Node ≥ 23.6). Everything app-specific lives here; the tool knows no
 * app names, paths or flavors of its own.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
/** Identity helper for typed configs. */
export function defineConfig(config) {
    return config;
}
export const CONFIG_NAMES = [
    "rn-build-cache.config.mjs",
    "rn-build-cache.config.js",
    "rn-build-cache.config.json",
    "rn-build-cache.config.ts",
];
/** Finds the config in `from` or the nearest parent directory. */
export function findConfig(from) {
    let dir = resolve(from);
    for (;;) {
        for (const name of CONFIG_NAMES) {
            const path = join(dir, name);
            if (existsSync(path))
                return path;
        }
        const parent = dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
export async function loadConfig(path) {
    const raw = path.endsWith(".json")
        ? JSON.parse(readFileSync(path, "utf8"))
        : (await import(pathToFileURL(path).href)).default;
    return resolveConfig(raw, path);
}
/** Validates a raw config object and fills in defaults. Throws with a readable message. */
export function resolveConfig(raw, configPath) {
    const fail = (message) => {
        throw new Error(`${configPath}: ${message}`);
    };
    if (typeof raw !== "object" || raw === null)
        fail("the config must export an object");
    const config = raw;
    const root = dirname(configPath);
    const appDir = resolve(root, config.appDir ?? ".");
    if (!config.variants || Object.keys(config.variants).length === 0) {
        fail("`variants` needs at least one entry");
    }
    const variants = {};
    for (const [name, variant] of Object.entries(config.variants)) {
        if (!/^[a-z][a-z0-9]*$/.test(name)) {
            fail(`variant name "${name}" must be lowercase letters and digits (it prefixes cache keys)`);
        }
        if (variant.buildType !== "debug" && variant.buildType !== "release") {
            fail(`variants.${name}.buildType must be "debug" or "release"`);
        }
        const cap = variant.buildType === "debug" ? "Debug" : "Release";
        variants[name] = {
            name,
            buildType: variant.buildType,
            description: variant.description ?? `${name} (${variant.buildType})`,
            env: variant.env ?? {},
            envDefaults: variant.envDefaults ?? {},
            envFile: variant.envFile ?? null,
            gradleTask: variant.gradleTask ?? `:app:assemble${cap}`,
            gradleArgs: variant.gradleArgs ?? [],
            apkPath: variant.apkPath ??
                `app/build/outputs/apk/${variant.buildType}/app-${variant.buildType}.apk`,
            prepare: variant.prepare ?? [],
            resetMetroCache: variant.resetMetroCache ?? true,
            embedsJs: variant.buildType === "release",
        };
    }
    const keystore = config.signing?.keystore ?? "android/app/debug.keystore";
    return {
        configPath,
        root,
        appDir,
        abi: config.abi ?? "arm64-v8a",
        variants,
        signing: {
            keystore: isAbsolute(keystore) ? keystore : resolve(appDir, keystore),
            storePassword: config.signing?.storePassword ?? "android",
            keyAlias: config.signing?.keyAlias ?? "androiddebugkey",
            keyPassword: config.signing?.keyPassword ?? "android",
        },
        prebuild: config.prebuild ?? dependsOnExpo(appDir),
        keyExtras: config.keyExtras ?? {},
        remote: {
            enabled: config.remote?.enabled ?? true,
            repo: config.remote?.repo ?? null,
            tag: config.remote?.tag ?? "native-build-cache",
            keepPerVariant: config.remote?.keepPerVariant ?? 8,
        },
        local: {
            dir: config.local?.dir ? resolve(root, config.local.dir) : null,
            keep: config.local?.keep ?? 3,
        },
    };
}
export function dependsOnExpo(appDir) {
    try {
        const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
        return Boolean(pkg.dependencies?.expo);
    }
    catch {
        return false;
    }
}
