/**
 * The cache-miss path: optional `expo prebuild`, then the full Gradle build.
 *
 * Ordering matters: everything the caller needs from the build (the APK, the emitted asset
 * hashes, the bundle's bytecode version) is copied or read BEFORE android/ is restored after
 * prebuild. The restore itself only reverts tracked files and deletes the untracked, non-ignored
 * files prebuild created — never ignored build output.
 */
import { existsSync, realpathSync, rmSync, rmdirSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { capture, log, onPath, run } from "./exec.js";
import { apkHbcVersion, hashTree, readHbcVersion } from "./swap.js";
export function defaultSteps(toolchain) {
    return {
        async prebuild(appDir, env) {
            if (!toolchain.expoCli)
                throw new Error("prebuild is on but expo is not installed");
            await run("node", [toolchain.expoCli, "prebuild", "--platform", "android", "--no-install"], {
                cwd: appDir,
                env: { ...env, EXPO_NO_TELEMETRY: "1", CI: env.CI ?? "1" },
            });
        },
        async gradle(androidDir, args, env) {
            await run("./gradlew", args, { cwd: androidDir, env });
        },
    };
}
export async function fullBuild(options) {
    const { appDir, variant, env, reporter } = options;
    const steps = options.steps ?? defaultSteps(options.toolchain);
    const androidDir = join(appDir, "android");
    const gitRoot = gitTopLevel(appDir);
    // Both sides real paths: git reports /private/var/… for a /var/… (macOS tmp) checkout.
    const androidPath = gitRoot && existsSync(androidDir)
        ? relative(realpathSync(gitRoot), realpathSync(androidDir)) || "."
        : null;
    // prebuild rewrites tracked android/ files for the flavor. Put them back afterwards — but only
    // when they were clean to begin with, so nobody's uncommitted native edit is thrown away.
    const restorable = gitRoot && androidPath && isClean(gitRoot, androidPath);
    try {
        if (options.prebuild) {
            reporter.start("prebuild", "expo prebuild (android)");
            await steps.prebuild(appDir, env);
            reporter.done("prebuild");
        }
        else {
            reporter.skip("prebuild", "not an Expo prebuild project");
        }
        const gradleEnv = withCcache(env, gitRoot ?? appDir);
        const ccache = gradleEnv.CMAKE_CXX_COMPILER_LAUNCHER === "ccache" && onPath("ccache");
        if (ccache)
            capture("ccache", ["--zero-stats"], { cwd: androidDir, env: gradleEnv });
        reporter.start("gradle", `gradle ${variant.gradleTask}`);
        const args = [
            variant.gradleTask,
            `-PreactNativeArchitectures=${options.abi}`,
            "--build-cache",
            ...variant.gradleArgs,
        ];
        const delay = options.retryDelaySeconds ?? 60;
        for (let attempt = 1;; attempt++) {
            try {
                await steps.gradle(androidDir, args, gradleEnv);
                break;
            }
            catch (error) {
                // Maven and registry flakes are the usual failure here, not real build errors.
                if (attempt >= 3) {
                    reporter.fail("gradle", String(error));
                    throw error;
                }
                reporter.progress("gradle", `attempt ${attempt} failed; retrying in ${delay * attempt}s`);
                await new Promise((resolve) => setTimeout(resolve, delay * 1000 * attempt));
            }
        }
        let stats = "";
        try {
            if (ccache)
                stats = capture("ccache", ["--print-stats"], { cwd: androidDir, env: gradleEnv });
        }
        catch {
            // ccache < 4.5 has no --print-stats; the summary is cosmetic.
        }
        reporter.done("gradle", ccache ? ccacheSummary(stats) : undefined);
        const built = join(androidDir, variant.apkPath);
        if (!existsSync(built))
            throw new Error(`gradle succeeded but ${built} is missing`);
        await mkdir(dirname(options.outPath), { recursive: true });
        await copyFile(built, options.outPath);
        if (!variant.embedsJs)
            return { apkPath: options.outPath, assets: null, hbcVersion: null };
        // What the RN Gradle plugin emitted for this variant: the swap compares against it next time.
        const generated = join(androidDir, "app", "build", "generated");
        const resDir = join(generated, "res", "react", variant.buildType);
        const bundle = join(generated, "assets", "react", variant.buildType, "index.android.bundle");
        return {
            apkPath: options.outPath,
            assets: existsSync(resDir) ? await hashTree(resDir) : null,
            hbcVersion: (await readHbcVersion(bundle)) ?? apkHbcVersion(options.outPath),
        };
    }
    finally {
        if (restorable && gitRoot && androidPath && !isClean(gitRoot, androidPath)) {
            log(`restoring ${androidPath}/ to its committed state after prebuild`);
            restoreTree(gitRoot, androidPath);
        }
    }
}
/**
 * Reverts tracked files under `path` and deletes the untracked, NON-ignored files there (what a
 * prebuild adds), then any directories that leaves empty. Ignored files — Gradle's build/, .cxx/,
 * local.properties — are never touched.
 */
export function restoreTree(gitRoot, path) {
    capture("git", ["checkout", "--", path], { cwd: gitRoot });
    const added = capture("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", path], {
        cwd: gitRoot,
    })
        .split("\0")
        .filter(Boolean);
    const dirs = new Set();
    for (const file of added) {
        rmSync(join(gitRoot, file), { force: true });
        for (let dir = dirname(file); dir !== "." && dir.startsWith(path); dir = dirname(dir)) {
            dirs.add(dir);
        }
    }
    // Deepest first, and only when empty.
    for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
        try {
            rmdirSync(join(gitRoot, dir));
        }
        catch {
            // not empty (or already gone)
        }
    }
}
function gitTopLevel(dir) {
    try {
        return capture("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
    }
    catch {
        return null;
    }
}
/** No tracked modification and no untracked (non-ignored) file under `path`. */
function isClean(gitRoot, path) {
    try {
        return capture("git", ["status", "--porcelain", "--", path], { cwd: gitRoot }) === "";
    }
    catch {
        return false;
    }
}
/** `ccache --print-stats` counters as "hits/total". */
export function ccacheSummary(stats) {
    const read = (name) => Number(new RegExp(`^${name}\\t(\\d+)`, "m").exec(stats)?.[1] ?? 0);
    const hits = read("direct_cache_hit") + read("preprocessed_cache_hit");
    const misses = read("cache_miss");
    return hits + misses > 0 ? `ccache ${hits}/${hits + misses} hits` : "ccache: no C++ compiled";
}
/**
 * ccache for React Native's C++ through CMake's compiler launcher: AGP's CMake tasks are not
 * cacheable by Gradle, so without it every build recompiles every translation unit. Values the
 * caller already set win.
 */
export function withCcache(env, baseDir) {
    if (!onPath("ccache") || env.CMAKE_CXX_COMPILER_LAUNCHER)
        return env;
    return {
        CMAKE_C_COMPILER_LAUNCHER: "ccache",
        CMAKE_CXX_COMPILER_LAUNCHER: "ccache",
        CCACHE_DIR: join(homedir(), ".cache", "ccache"),
        CCACHE_BASEDIR: baseDir,
        CCACHE_NOHASHDIR: "true",
        CCACHE_SLOPPINESS: "pch_defines,time_macros,include_file_mtime,include_file_ctime",
        CCACHE_COMPRESS: "true",
        CCACHE_MAXSIZE: "2G",
        ...env,
    };
}
