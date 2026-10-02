/**
 * `rn-build-cache` — an Android APK, from cache whenever the native side has not changed.
 * Interactive in a terminal, plain in CI or with `--variant`. See README.md.
 */

import { appendFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, USAGE, wantsInteractive } from "./args.js";
import { runBuild, runCheck, type BuildResult, type CheckResult } from "./build.js";
import { findConfig, loadConfig, type ResolvedConfig } from "./config.js";
import { formatDuration, log, run } from "./exec.js";
import { defaultCacheDir } from "./local-store.js";
import { createPlainReporter } from "./reporter.js";

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("help" in parsed) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}\n`);
    return 2;
  }
  const options = parsed;

  const configPath = options.config ?? findConfig(process.cwd());
  if (!configPath) {
    process.stderr.write(
      "No rn-build-cache.config.{mjs,js,json,ts} found here or in a parent directory.\n",
    );
    return 2;
  }
  const config = await loadConfig(configPath);

  const interactive = wantsInteractive(options, process.env, {
    stdin: Boolean(process.stdin.isTTY),
    stdout: Boolean(process.stdout.isTTY),
  });
  const tui = interactive ? await import("./tui.js") : null;

  let variantName = options.variant;
  let cache = options.cache;
  let installAsked = options.install;
  if (tui) {
    const choices = await tui.ask(config);
    if (!choices) return 130;
    variantName = choices.variant;
    cache = choices.cache && options.cache;
    installAsked = choices.install || options.install;
  }
  const names = Object.keys(config.variants);
  if (!variantName) {
    process.stderr.write(`--variant is required (one of: ${names.join(", ")})\n`);
    return 2;
  }
  const variant = config.variants[variantName];
  if (!variant) {
    process.stderr.write(`unknown variant "${variantName}" (one of: ${names.join(", ")})\n`);
    return 2;
  }

  if (options.check) {
    const checked = await runCheck(
      config,
      variant,
      { remote: options.remote, explain: options.explain },
      createPlainReporter(),
    ).catch((error: unknown) => {
      log(`failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      return null;
    });
    if (!checked) return 1;
    const line = summarizeCheck(variant.name, checked);
    writeCheckOutputs(checked);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
    process.stdout.write(`${line}\n`);
    return 0;
  }

  const cacheDir = config.local.dir ?? defaultCacheDir();
  await mkdir(cacheDir, { recursive: true });
  const logPath = join(cacheDir, "last-build.log");
  const live = tui ? tui.createLiveReporter(logPath) : null;
  const reporter = live ?? createPlainReporter();

  let result: BuildResult;
  try {
    result = await runBuild(
      config,
      {
        variant,
        cache,
        remote: options.remote,
        upload: options.upload,
        cacheOnly: options.cacheOnly,
        prepare: options.prepare,
        out: options.out,
        explain: options.explain,
      },
      reporter,
    );
  } catch (error) {
    live?.stop();
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    if (tui) {
      tui.prompts.log.error(message.split("\n")[0] ?? message);
      tui.prompts.outro(`Build failed — full output in ${logPath}`);
    } else {
      log(`failed: ${message}`);
    }
    return 1;
  }
  live?.stop();

  const summary = summarize(variant.name, result);
  writeGithubOutputs(result);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  if (result.outcome === "none") {
    if (tui) tui.prompts.outro(summary);
    else log(summary);
    return 0;
  }

  if (tui) {
    tui.prompts.note(`${result.apkPath}\n${tui.color.dim(`log: ${logPath}`)}`, summary);
    const device = await tui.chooseDevice(installAsked);
    if (device) {
      const spin = tui.prompts.spinner();
      spin.start(`Installing on ${device.name}`);
      try {
        await install(result.apkPath as string, device.serial, config);
        spin.stop(`Installed on ${device.name}`);
      } catch (error) {
        spin.error(`Install failed: ${String(error)}`);
        return 1;
      }
    }
    tui.prompts.outro("Done");
    return 0;
  }

  process.stdout.write(`${summary}\n`);
  if (options.install) {
    const plain = createPlainReporter();
    plain.start("install", "adb install -r");
    await install(result.apkPath as string, options.device, config);
    plain.done("install");
  }
  return 0;
}

async function install(apk: string, serial: string | null, config: ResolvedConfig): Promise<void> {
  await run("adb", [...(serial ? ["-s", serial] : []), "install", "-r", apk], { cwd: config.root });
}

/** The one line a person or a log scraper reads: what happened, how long, how much it saved. */
export function summarize(variant: string, result: BuildResult): string {
  const took = formatDuration(result.elapsedMs);
  if (result.outcome === "none") {
    const why = result.fallbackReason ? ` (${result.fallbackReason})` : "";
    return `rn-build-cache: ${variant} — no usable cache entry for ${result.key}${why}; not building (--cache-only)`;
  }
  if (result.outcome === "miss") {
    const why = result.fallbackReason ? ` (cached entry unusable: ${result.fallbackReason})` : "";
    return `rn-build-cache: ${variant} MISS — full build in ${took}, now cached as ${result.key}${why}`;
  }
  const how =
    result.outcome === "swap" ? "native reused, this commit's JS swapped in" : "APK reused as is";
  const saved =
    result.baselineSeconds === null
      ? ""
      : `, saved ~${formatDuration(result.baselineSeconds * 1000 - result.elapsedMs)} of a ${formatDuration(result.baselineSeconds * 1000)} build`;
  return `rn-build-cache: ${variant} HIT (${result.source}; ${how}) in ${took}${saved}`;
}

export function summarizeCheck(variant: string, result: CheckResult): string {
  const took = formatDuration(result.elapsedMs);
  if (result.cachedIn) {
    return `rn-build-cache: ${variant} CACHED (${result.cachedIn}) as ${result.key} — checked in ${took}`;
  }
  const why = result.changes ? ` (${result.changes})` : "";
  return `rn-build-cache: ${variant} NOT CACHED — ${result.key} needs a full build${why}; checked in ${took}`;
}

function writeCheckOutputs(result: CheckResult): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const values: Record<string, string> = {
    cached: result.cachedIn ? "true" : "false",
    key: result.key,
    fingerprint: result.fingerprint,
    "newest-key": result.newest?.key ?? "",
    "newest-commit": result.newest?.commit ?? "",
    changes: result.changes ?? "",
  };
  appendFileSync(
    file,
    Object.entries(values)
      .map(([k, v]) => `${k}=${v.replace(/\r?\n/g, " ")}\n`)
      .join(""),
  );
}

function writeGithubOutputs(result: BuildResult): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const values: Record<string, string> = {
    hit: result.outcome === "hit" || result.outcome === "swap" ? "true" : "false",
    cache: result.outcome,
    key: result.key,
    apk: result.apkPath ?? "",
  };
  appendFileSync(
    file,
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(""),
  );
}
