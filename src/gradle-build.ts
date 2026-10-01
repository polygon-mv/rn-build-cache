/**
 * The cache-miss path: optional `expo prebuild`, then the full Gradle build.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { ResolvedVariant } from "./config.js";
import { capture, log, onPath, run } from "./exec.js";
import type { Toolchain } from "./fingerprint.js";
import type { Reporter } from "./reporter.js";
import { apkHbcVersion, hashTree, readHbcVersion } from "./swap.js";

export interface FullBuildResult {
  readonly apkPath: string;
  readonly assets: Record<string, string> | null;
  readonly hbcVersion: number | null;
}

export async function fullBuild(options: {
  readonly appDir: string;
  readonly abi: string;
  readonly prebuild: boolean;
  readonly toolchain: Toolchain;
  readonly variant: ResolvedVariant;
  readonly env: NodeJS.ProcessEnv;
  readonly reporter: Reporter;
}): Promise<FullBuildResult> {
  const { appDir, variant, env, reporter } = options;
  const androidDir = join(appDir, "android");
  const gitRoot = gitTopLevel(appDir);
  const androidPath = gitRoot ? relative(gitRoot, androidDir) || "." : null;

  // prebuild rewrites tracked android/ files for the flavor. Put them back afterwards — but only
  // when they were clean to begin with, so nobody's uncommitted native edit is thrown away.
  const androidWasClean = gitRoot && androidPath ? isClean(gitRoot, androidPath) : false;
  try {
    if (options.prebuild) {
      if (!options.toolchain.expoCli) throw new Error("prebuild is on but expo is not installed");
      reporter.start("prebuild", "expo prebuild (android)");
      await run(
        "node",
        [options.toolchain.expoCli, "prebuild", "--platform", "android", "--no-install"],
        { cwd: appDir, env: { ...env, EXPO_NO_TELEMETRY: "1", CI: env.CI ?? "1" } },
      );
      reporter.done("prebuild");
    } else {
      reporter.skip("prebuild", "not an Expo prebuild project");
    }

    const gradleEnv = withCcache(env, gitRoot ?? appDir);
    const ccache = gradleEnv.CMAKE_CXX_COMPILER_LAUNCHER === "ccache" && onPath("ccache");
    if (ccache) capture("ccache", ["--zero-stats"], { cwd: androidDir, env: gradleEnv });
    reporter.start("gradle", `gradle ${variant.gradleTask}`);
    const args = [
      variant.gradleTask,
      `-PreactNativeArchitectures=${options.abi}`,
      "--build-cache",
      ...variant.gradleArgs,
    ];
    for (let attempt = 1; ; attempt++) {
      try {
        await run("./gradlew", args, { cwd: androidDir, env: gradleEnv });
        break;
      } catch (error) {
        // Maven and registry flakes are the usual failure here, not real build errors.
        if (attempt >= 3) {
          reporter.fail("gradle", String(error));
          throw error;
        }
        reporter.progress("gradle", `attempt ${attempt} failed; retrying in ${60 * attempt}s`);
        await new Promise((resolve) => setTimeout(resolve, 60_000 * attempt));
      }
    }
    let stats = "";
    try {
      if (ccache) stats = capture("ccache", ["--print-stats"], { cwd: androidDir, env: gradleEnv });
    } catch {
      // ccache < 4.5 has no --print-stats; the summary is cosmetic.
    }
    reporter.done("gradle", ccache ? ccacheSummary(stats) : undefined);

    const apkPath = join(androidDir, variant.apkPath);
    if (!existsSync(apkPath)) throw new Error(`gradle succeeded but ${apkPath} is missing`);
    if (!variant.embedsJs) return { apkPath, assets: null, hbcVersion: null };

    // What the RN Gradle plugin emitted for this variant: the swap compares against it next time.
    const generated = join(androidDir, "app", "build", "generated");
    const resDir = join(generated, "res", "react", variant.buildType);
    const bundle = join(generated, "assets", "react", variant.buildType, "index.android.bundle");
    return {
      apkPath,
      assets: existsSync(resDir) ? await hashTree(resDir) : null,
      hbcVersion: (await readHbcVersion(bundle)) ?? apkHbcVersion(apkPath),
    };
  } finally {
    if (gitRoot && androidPath && androidWasClean && !isClean(gitRoot, androidPath)) {
      log(`restoring ${androidPath}/ to its committed state after prebuild`);
      capture("git", ["checkout", "--", androidPath], { cwd: gitRoot });
      capture("git", ["clean", "-fdq", "--", androidPath], { cwd: gitRoot });
    }
  }
}

function gitTopLevel(dir: string): string | null {
  try {
    return capture("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
  } catch {
    return null;
  }
}

/** No tracked modification and no untracked (non-ignored) file under `path`. */
function isClean(gitRoot: string, path: string): boolean {
  try {
    return capture("git", ["status", "--porcelain", "--", path], { cwd: gitRoot }) === "";
  } catch {
    return false;
  }
}

/** `cacheable_call`-style counters from `ccache --print-stats` as "hits/total". */
export function ccacheSummary(stats: string): string {
  const read = (name: string) => Number(new RegExp(`^${name}\\t(\\d+)`, "m").exec(stats)?.[1] ?? 0);
  const hits = read("direct_cache_hit") + read("preprocessed_cache_hit");
  const misses = read("cache_miss");
  return hits + misses > 0 ? `ccache ${hits}/${hits + misses} hits` : "ccache: no C++ compiled";
}

/**
 * ccache for React Native's C++ through CMake's compiler launcher: AGP's CMake tasks are not
 * cacheable by Gradle, so without it every build recompiles every translation unit. Values the
 * caller already set win.
 */
export function withCcache(env: NodeJS.ProcessEnv, baseDir: string): NodeJS.ProcessEnv {
  if (!onPath("ccache") || env.CMAKE_CXX_COMPILER_LAUNCHER) return env;
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
