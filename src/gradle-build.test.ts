import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveConfig } from "./config.js";
import type { Toolchain } from "./fingerprint.js";
import { fullBuild, restoreTree, type BuildSteps } from "./gradle-build.js";
import type { Reporter } from "./reporter.js";

const quiet: Reporter = { start() {}, progress() {}, done() {}, skip() {}, fail() {} };
const toolchain: Toolchain = {
  reactNative: "0.0.0",
  hermesCompiler: "0",
  hermesc: "/nonexistent",
  reactNativeCli: "/nonexistent",
  expoCli: "/nonexistent",
  expoConstantsDir: null,
};

/** A git repo with app/android/{.gitignore, tracked.gradle} committed. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rnbc-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();
  git("init", "-q");
  const android = join(root, "app", "android");
  mkdirSync(android, { recursive: true });
  writeFileSync(join(android, ".gitignore"), "build/\n.cxx/\n");
  writeFileSync(join(android, "tracked.gradle"), "committed\n");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return { root, android, git };
}

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe("full build ordering", () => {
  test("the APK is copied out before android/ is restored, and build output survives", async () => {
    const { root, android, git } = fixture();
    const config = resolveConfig(
      { appDir: "app", prebuild: true, variants: { dev: { buildType: "debug" } } },
      join(root, "rn-build-cache.config.json"),
    );
    const events: string[] = [];
    const steps: BuildSteps = {
      async prebuild() {
        events.push("prebuild");
        writeFileSync(join(android, "tracked.gradle"), "prebuilt for a flavor\n");
        write(join(android, "app", "src", "flavor", "Main.kt"), "new file");
      },
      async gradle() {
        events.push("gradle");
        write(join(android, "app", "build", "outputs", "apk", "debug", "app-debug.apk"), "APK");
        write(join(android, "app", ".cxx", "obj.o"), "object");
      },
    };
    const outPath = join(root, "out", "dev.apk");
    const result = await fullBuild({
      appDir: config.appDir,
      abi: "arm64-v8a",
      prebuild: true,
      toolchain,
      variant: config.variants.dev!,
      env: { ...process.env, CMAKE_CXX_COMPILER_LAUNCHER: "none" },
      reporter: quiet,
      outPath,
      steps,
      retryDelaySeconds: 0,
    });

    expect(events).toEqual(["prebuild", "gradle"]);
    expect(result.apkPath).toBe(outPath);
    expect(readFileSync(outPath, "utf8")).toBe("APK");
    // Restored: tracked file reverted, prebuild's new file gone, tree clean again.
    expect(readFileSync(join(android, "tracked.gradle"), "utf8")).toBe("committed\n");
    expect(existsSync(join(android, "app", "src"))).toBe(false);
    expect(git("status", "--porcelain", "--", "app/android")).toBe("");
    // Ignored build output is untouched.
    expect(
      existsSync(join(android, "app", "build", "outputs", "apk", "debug", "app-debug.apk")),
    ).toBe(true);
    expect(existsSync(join(android, "app", ".cxx", "obj.o"))).toBe(true);
  });

  test("a dirty android/ is left alone", async () => {
    const { root, android } = fixture();
    writeFileSync(join(android, "tracked.gradle"), "my uncommitted edit\n");
    const config = resolveConfig(
      { appDir: "app", prebuild: false, variants: { dev: { buildType: "debug" } } },
      join(root, "rn-build-cache.config.json"),
    );
    await fullBuild({
      appDir: config.appDir,
      abi: "arm64-v8a",
      prebuild: false,
      toolchain,
      variant: config.variants.dev!,
      env: { ...process.env, CMAKE_CXX_COMPILER_LAUNCHER: "none" },
      reporter: quiet,
      outPath: join(root, "out.apk"),
      steps: {
        async prebuild() {},
        async gradle() {
          write(join(android, "app", "build", "outputs", "apk", "debug", "app-debug.apk"), "APK");
        },
      },
    });
    expect(readFileSync(join(android, "tracked.gradle"), "utf8")).toBe("my uncommitted edit\n");
  });

  test("gradle is retried, and a failure still restores android/", async () => {
    const { root, android } = fixture();
    const config = resolveConfig(
      { appDir: "app", prebuild: true, variants: { dev: { buildType: "debug" } } },
      join(root, "rn-build-cache.config.json"),
    );
    let attempts = 0;
    const build = fullBuild({
      appDir: config.appDir,
      abi: "arm64-v8a",
      prebuild: true,
      toolchain,
      variant: config.variants.dev!,
      env: { ...process.env, CMAKE_CXX_COMPILER_LAUNCHER: "none" },
      reporter: quiet,
      outPath: join(root, "out.apk"),
      retryDelaySeconds: 0,
      steps: {
        async prebuild() {
          writeFileSync(join(android, "tracked.gradle"), "prebuilt\n");
        },
        async gradle() {
          attempts++;
          throw new Error("maven flake");
        },
      },
    });
    await expect(build).rejects.toThrow("maven flake");
    expect(attempts).toBe(3);
    expect(readFileSync(join(android, "tracked.gradle"), "utf8")).toBe("committed\n");
  });
});

describe("restoreTree", () => {
  test("only touches its own path", () => {
    const { root, android } = fixture();
    write(join(root, "elsewhere.txt"), "untracked outside android");
    write(join(android, "new.txt"), "x");
    restoreTree(root, "app/android");
    expect(existsSync(join(android, "new.txt"))).toBe(false);
    expect(existsSync(join(root, "elsewhere.txt"))).toBe(true);
  });
});
