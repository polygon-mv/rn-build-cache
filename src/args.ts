/** Command-line parsing, kept pure so it is testable. */

export interface CliOptions {
  /** Null when not given: the TUI asks, plain mode fails. */
  readonly variant: string | null;
  readonly config: string | null;
  /** False with `--no-cache`: skip the lookup, build, and still refresh the cache. */
  readonly cache: boolean;
  /** False with `--no-remote`: this machine's cache only. */
  readonly remote: boolean;
  /** Upload a fresh build to the shared cache. Defaults to on in CI, off locally. */
  readonly upload: boolean;
  /**
   * Use the cache or do nothing: on a miss (or an unsafe swap) report `hit=false` and exit 0
   * without running Gradle, so CI can prepare the runner for a full build only when it needs one.
   */
  readonly cacheOnly: boolean;
  /** Run every prepare step, including ones whose `unlessExists` output is present. */
  readonly prepare: boolean;
  readonly install: boolean;
  readonly device: string | null;
  readonly out: string | null;
  readonly explain: boolean;
  /** Force plain output even on a TTY. */
  readonly plain: boolean;
}

export const USAGE = `Usage: rn-build-cache [--variant <name>] [options]

Run without --variant in a terminal for the interactive UI.

  --variant <name>       a variant from rn-build-cache.config (e.g. dev, staging)
  --install              adb install -r the result (add --device <serial> with several devices)
  --out <path>           where to write the APK
  --no-cache             skip the lookup and build; the result still refreshes the cache
  --no-remote            use only the local cache, never the GitHub release
  --upload / --no-upload share a fresh build on the GitHub release (default: on in CI only)
  --cache-only           build from the cache or do nothing (exit 0, hit=false); never Gradle
  --prepare              run every prepare step, even ones whose output already exists
  --config <path>        config file (default: nearest rn-build-cache.config.* upwards)
  --explain              print what the cache key is made of
  --plain                no interactive UI, even in a terminal`;

export function parseArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): CliOptions | { error: string } | { help: true } {
  let variant: string | null = null;
  let config: string | null = null;
  let cache = true;
  let remote = true;
  let upload = env.CI === "true";
  let cacheOnly = false;
  let prepare = false;
  let install = false;
  let device: string | null = null;
  let out: string | null = null;
  let explain = false;
  let plain = false;

  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift() as string;
    const eq = arg.indexOf("=");
    const [flag, inline] = eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, null];
    const value = (): string | null => inline ?? args.shift() ?? null;
    switch (flag) {
      case "--":
        break;
      case "-h":
      case "--help":
        return { help: true };
      case "--variant":
        variant = value();
        if (!variant) return { error: "--variant needs a name" };
        break;
      case "--config":
        config = value();
        if (!config) return { error: "--config needs a path" };
        break;
      case "--no-cache":
        cache = false;
        break;
      case "--no-remote":
        remote = false;
        break;
      case "--upload":
        upload = true;
        break;
      case "--no-upload":
        upload = false;
        break;
      case "--cache-only":
        cacheOnly = true;
        break;
      case "--prepare":
        prepare = true;
        break;
      case "--install":
        install = true;
        break;
      case "--device":
        device = value();
        if (!device) return { error: "--device needs a serial" };
        break;
      case "--out":
        out = value();
        if (!out) return { error: "--out needs a path" };
        break;
      case "--explain":
        explain = true;
        break;
      case "--plain":
        plain = true;
        break;
      default:
        return { error: `unknown option ${arg}` };
    }
  }
  if (cacheOnly && !cache) return { error: "--cache-only and --no-cache contradict each other" };
  return {
    variant,
    config,
    cache,
    remote,
    upload,
    cacheOnly,
    prepare,
    install,
    device,
    out,
    explain,
    plain,
  };
}

/**
 * The interactive UI only when a person is clearly at the keyboard: a TTY on both ends, not CI,
 * and no variant given (a variant on the command line means a script or a habit — run it).
 */
export function wantsInteractive(
  options: Pick<CliOptions, "variant" | "plain">,
  env: Readonly<Record<string, string | undefined>>,
  tty: { stdin: boolean; stdout: boolean },
): boolean {
  if (options.plain || options.variant !== null) return false;
  if (env.CI === "true" || env.CI === "1") return false;
  return tty.stdin && tty.stdout;
}
