/**
 * Puts the current commit's JS into a COPY of a cached release APK, exactly where Gradle would.
 *
 * Up to three APK entries change per commit, and each one present in the cached APK is rewritten:
 *
 * - `assets/index.android.bundle`: bundled the way the RN Gradle plugin does it (`export:embed` in
 *   an Expo app, `react-native bundle` otherwise, with `--reset-cache --minify false`), compiled
 *   with `hermesc -emit-binary -O`, and stored uncompressed as AGP stores it so Hermes can mmap it.
 * - `assets/app.config` (expo-constants): the serialised app config, including `extra`, which the
 *   fingerprint deliberately ignores.
 * - `assets/app.manifest` (expo-updates): the embedded update manifest. Its `id` must be NEW: the
 *   embedded loader copies the embedded update into its own store keyed by that id, so a device
 *   that ran the previous APK would otherwise keep launching the previous JS. The asset list is
 *   carried over, which is only correct because {@link decideSwap} proved the asset set unchanged.
 *
 * Then `zipalign -P 16` (16 KB pages for the `.so` files) and `apksigner`. Re-signing with the key
 * the release build type uses keeps the result installable over a Gradle-built APK.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { capture, run } from "./exec.js";
import { sha256File } from "./local-store.js";
import { decideSwap, hbcVersion } from "./swap-safety.js";
const BUNDLE = "assets/index.android.bundle";
export async function swapJsIntoApk(options) {
    try {
        return await swapIn(options);
    }
    finally {
        await rm(join(options.workDir, "swap"), { recursive: true, force: true }).catch(() => undefined);
    }
}
async function swapIn(options) {
    const { appDir, toolchain, env, reporter } = options;
    const stage = join(options.workDir, "swap");
    const assetsDir = join(stage, "assets");
    const resDir = join(stage, "res");
    await rm(stage, { recursive: true, force: true });
    await mkdir(assetsDir, { recursive: true });
    await mkdir(resDir, { recursive: true });
    const tools = findBuildTools();
    if (!tools)
        return { ok: false, reason: "no Android build-tools with zipalign + apksigner found" };
    if (!existsSync(toolchain.hermesc)) {
        return { ok: false, reason: `hermesc missing at ${toolchain.hermesc}` };
    }
    if (!existsSync(options.signing.keystore)) {
        return { ok: false, reason: `signing keystore missing at ${options.signing.keystore}` };
    }
    const inApk = listEntries(options.cachedApk);
    if (!inApk.has(BUNDLE))
        return { ok: false, reason: `the cached APK has no ${BUNDLE}` };
    const bundle = join(stage, BUNDLE);
    reporter.start("bundle", "Bundle JS + compile Hermes bytecode");
    try {
        const { command, args } = bundleCommand(appDir, toolchain, bundle, resDir, env);
        await run(command, args, { cwd: appDir, env });
        await run(toolchain.hermesc, ["-w", "-emit-binary", "-max-diagnostic-width=80", "-O", "-out", `${bundle}.hbc`, bundle], { cwd: appDir, env });
        await rename(`${bundle}.hbc`, bundle);
    }
    catch (error) {
        reporter.fail("bundle", String(error));
        return { ok: false, reason: `bundling failed: ${String(error)}` };
    }
    const fresh = { assets: await hashTree(resDir), hbcVersion: await readHbcVersion(bundle) };
    reporter.done("bundle", `HBC v${fresh.hbcVersion ?? "?"}, ${Object.keys(fresh.assets).length} assets`);
    const decision = decideSwap(options.meta, fresh);
    if (!decision.safe)
        return { ok: false, reason: decision.reason };
    reporter.start("swap", "Swap into a copy of the cached APK, zipalign, sign");
    try {
        const replaced = [BUNDLE];
        if (inApk.has("assets/app.config")) {
            if (!toolchain.expoConstantsDir) {
                throw new Error("the APK embeds assets/app.config but expo-constants is not resolvable");
            }
            await run("node", [join(toolchain.expoConstantsDir, "scripts", "getAppConfig.js"), appDir, assetsDir], { cwd: appDir, env });
            replaced.push("assets/app.config");
        }
        if (inApk.has("assets/app.manifest")) {
            const manifest = JSON.parse(capture("unzip", ["-p", options.cachedApk, "assets/app.manifest"], { cwd: stage }));
            await writeFile(join(assetsDir, "app.manifest"), JSON.stringify({ ...manifest, id: randomUUID(), commitTime: Date.now() }));
            replaced.push("assets/app.manifest");
        }
        await repackApk({
            stage,
            entries: replaced,
            cachedApk: options.cachedApk,
            outPath: options.outPath,
            signing: options.signing,
            tools,
        });
        reporter.done("swap", replaced.map((entry) => entry.replace("assets/", "")).join(", "));
    }
    catch (error) {
        reporter.fail("swap", String(error));
        return { ok: false, reason: `repacking failed: ${String(error)}` };
    }
    return { ok: true, apkPath: options.outPath };
}
function bundleCommand(appDir, toolchain, bundle, resDir, env) {
    const common = [
        "--platform",
        "android",
        "--dev",
        "false",
        "--reset-cache",
        "--bundle-output",
        bundle,
        "--assets-dest",
        resDir,
        "--minify",
        "false",
    ];
    if (toolchain.expoCli) {
        const entry = capture("node", ["-e", "require('expo/scripts/resolveAppEntry')", appDir, "android", "absolute"], { cwd: appDir, env });
        return {
            command: "node",
            args: [toolchain.expoCli, "export:embed", "--entry-file", entry, ...common],
        };
    }
    const entry = ["index.android.js", "index.js"].find((name) => existsSync(join(appDir, name)));
    return {
        command: "node",
        args: [toolchain.reactNativeCli, "bundle", "--entry-file", entry ?? "index.js", ...common],
    };
}
/**
 * Replaces `entries` (staged under `stage`) in a copy of `cachedApk`, then aligns and signs it into
 * `outPath`. Throws on any failed step.
 */
export async function repackApk(options) {
    const { stage, tools, signing } = options;
    const unaligned = join(stage, "unaligned.apk");
    await copyFile(options.cachedApk, unaligned);
    // -0 for the bundle: stored, as AGP stores it. Anything else keeps the default deflate.
    const [stored, deflated] = [
        options.entries.filter((entry) => entry === BUNDLE),
        options.entries.filter((entry) => entry !== BUNDLE),
    ];
    if (stored.length > 0)
        capture("zip", ["-0", "-X", unaligned, ...stored], { cwd: stage });
    if (deflated.length > 0)
        capture("zip", ["-X", unaligned, ...deflated], { cwd: stage });
    const aligned = join(stage, "aligned.apk");
    const pageAlign = tools.major >= 35 ? ["-P", "16"] : ["-p"];
    capture(tools.zipalign, [...pageAlign, "-f", "4", unaligned, aligned], { cwd: stage });
    capture(tools.apksigner, [
        "sign",
        "--ks",
        signing.keystore,
        "--ks-pass",
        `pass:${signing.storePassword}`,
        "--ks-key-alias",
        signing.keyAlias,
        "--key-pass",
        `pass:${signing.keyPassword}`,
        aligned,
    ], { cwd: stage });
    capture(tools.apksigner, ["verify", aligned], { cwd: stage });
    await mkdir(dirname(options.outPath), { recursive: true });
    await copyFile(aligned, options.outPath);
}
function listEntries(apk) {
    return new Set(capture("unzip", ["-Z1", apk], { cwd: dirname(apk) }).split("\n"));
}
/** sha256 of every file under `dir`, by path relative to it. Empty when `dir` does not exist. */
export async function hashTree(dir) {
    const out = {};
    if (!existsSync(dir))
        return out;
    const walk = async (current) => {
        for (const entry of await readdir(current, { withFileTypes: true })) {
            const path = join(current, entry.name);
            if (entry.isDirectory())
                await walk(path);
            else if (entry.isFile())
                out[relative(dir, path)] = await sha256File(path);
        }
    };
    await walk(dir);
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
export async function readHbcVersion(path) {
    if (!existsSync(path))
        return null;
    const handle = await open(path, "r");
    try {
        const header = new Uint8Array(12);
        await handle.read(header, 0, 12, 0);
        return hbcVersion(header);
    }
    finally {
        await handle.close();
    }
}
/** Reads the bundle header straight out of an APK. */
export function apkHbcVersion(apkPath) {
    const bytes = capture("sh", ["-c", `unzip -p "$1" ${BUNDLE} | head -c 12 | od -An -tx1`, "sh", apkPath], { cwd: dirname(apkPath) });
    const header = Uint8Array.from(bytes.split(/\s+/).filter(Boolean), (hex) => Number.parseInt(hex, 16));
    return hbcVersion(header);
}
/** The newest SDK build-tools that has both zipalign and apksigner. */
export function findBuildTools() {
    const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
    if (!sdk)
        return null;
    const root = join(sdk, "build-tools");
    if (!existsSync(root))
        return null;
    const versions = readdirSync(root)
        .filter((name) => /^\d+(\.\d+)*/.test(name))
        .sort((a, b) => compareDotted(b, a));
    for (const version of versions) {
        const zipalign = join(root, version, "zipalign");
        const apksigner = join(root, version, "apksigner");
        if (existsSync(zipalign) && existsSync(apksigner)) {
            return { zipalign, apksigner, major: Number.parseInt(version, 10) };
        }
    }
    return null;
}
export function compareDotted(a, b) {
    const pa = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
    const pb = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0)
            return diff;
    }
    return 0;
}
