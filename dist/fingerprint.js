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
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
function loadFingerprint(appDir) {
    const require = createRequire(join(appDir, "package.json"));
    const attempts = [
        () => require.resolve("@expo/fingerprint"),
        () => require.resolve("@expo/fingerprint", { paths: [require.resolve("expo/package.json")] }),
    ];
    for (const attempt of attempts) {
        try {
            return require(attempt());
        }
        catch {
            // next
        }
    }
    throw new Error("could not resolve @expo/fingerprint from the app — it ships with `expo`; a bare React Native " +
        "app needs it as a devDependency");
}
/**
 * `extra` is skipped because apps commonly stamp the commit and build time into it, which would
 * change the hash on every commit. It is not native: it reaches the app as `assets/app.config`,
 * which the release swap regenerates. Package scripts cannot change the native build.
 *
 * Reads `process.env` through the app config, so the build's env must be set first.
 */
export async function nativeFingerprint(appDir) {
    const fingerprint = loadFingerprint(appDir);
    const skips = fingerprint.SourceSkips;
    const fp = await fingerprint.createFingerprintAsync(appDir, {
        platforms: ["android"],
        sourceSkips: (skips.ExpoConfigExtraSection ?? 0) | (skips.PackageJsonScriptsAll ?? 0),
        silent: true,
    });
    return {
        hash: fp.hash,
        sources: fp.sources.map((source) => ({
            id: source.filePath ?? source.id ?? source.type,
            hash: source.hash,
        })),
    };
}
export function resolveToolchain(appDir) {
    const require = createRequire(join(appDir, "package.json"));
    const tryResolve = (id, paths) => {
        try {
            return require.resolve(id, paths ? { paths } : undefined);
        }
        catch {
            return null;
        }
    };
    const version = (path) => JSON.parse(readFileSync(path, "utf8")).version;
    const rnPackage = tryResolve("react-native/package.json");
    if (!rnPackage)
        throw new Error(`react-native is not installed in ${appDir}`);
    const rnDir = dirname(rnPackage);
    const binDir = process.platform === "darwin"
        ? "osx-bin"
        : process.platform === "win32"
            ? "win64-bin"
            : "linux64-bin";
    // RN ≥ 0.83 ships hermesc in the `hermes-compiler` package; older versions under sdks/.
    const hermesPackage = tryResolve("hermes-compiler/package.json", [rnPackage]);
    const hermesc = hermesPackage
        ? join(dirname(hermesPackage), "hermesc", binDir, "hermesc")
        : join(rnDir, "sdks", "hermesc", binDir, "hermesc");
    const expoPackage = tryResolve("expo/package.json");
    const constants = tryResolve("expo-constants/package.json");
    return {
        reactNative: version(rnPackage),
        hermesCompiler: hermesPackage ? version(hermesPackage) : `rn-${version(rnPackage)}`,
        hermesc,
        reactNativeCli: join(rnDir, "cli.js"),
        expoCli: expoPackage ? tryResolve("@expo/cli", [expoPackage]) : null,
        expoConstantsDir: constants && existsSync(join(dirname(constants), "scripts", "getAppConfig.js"))
            ? dirname(constants)
            : null,
    };
}
