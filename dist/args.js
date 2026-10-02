/** Command-line parsing, kept pure so it is testable. */
export const USAGE = `Usage: rn-build-cache [--variant <name>] [options]

Run without --variant in a terminal for the interactive UI.

  --variant <name>       a variant from rn-build-cache.config (e.g. dev, staging)
  --install              adb install -r the result (add --device <serial> with several devices)
  --out <path>           where to write the APK
  --no-cache             skip the lookup and build; the result still refreshes the cache
  --no-remote            use only the local cache, never the GitHub release
  --upload / --no-upload share a fresh build on the GitHub release (default: on in CI only)
  --cache-only           build from the cache or do nothing (exit 0, hit=false); never Gradle
  --check                only report whether the cache has this build (exit 0, cached=true|false);
                         downloads and builds nothing
  --prepare              run every prepare step, even ones whose output already exists
  --config <path>        config file (default: nearest rn-build-cache.config.* upwards)
  --explain              print what the cache key is made of
  --plain                no interactive UI, even in a terminal`;
export function parseArgs(argv, env = process.env) {
    let variant = null;
    let config = null;
    let cache = true;
    let remote = true;
    let upload = env.CI === "true";
    let cacheOnly = false;
    let check = false;
    let prepare = false;
    let install = false;
    let device = null;
    let out = null;
    let explain = false;
    let plain = false;
    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        const eq = arg.indexOf("=");
        const [flag, inline] = eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, null];
        const value = () => inline ?? args.shift() ?? null;
        switch (flag) {
            case "--":
                break;
            case "-h":
            case "--help":
                return { help: true };
            case "--variant":
                variant = value();
                if (!variant)
                    return { error: "--variant needs a name" };
                break;
            case "--config":
                config = value();
                if (!config)
                    return { error: "--config needs a path" };
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
            case "--check":
                check = true;
                break;
            case "--prepare":
                prepare = true;
                break;
            case "--install":
                install = true;
                break;
            case "--device":
                device = value();
                if (!device)
                    return { error: "--device needs a serial" };
                break;
            case "--out":
                out = value();
                if (!out)
                    return { error: "--out needs a path" };
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
    if (cacheOnly && !cache)
        return { error: "--cache-only and --no-cache contradict each other" };
    if (check && !cache)
        return { error: "--check and --no-cache contradict each other" };
    if (check && !variant)
        return { error: "--check needs --variant" };
    return {
        variant,
        config,
        cache,
        remote,
        upload,
        cacheOnly,
        check,
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
export function wantsInteractive(options, env, tty) {
    if (options.plain || options.variant !== null)
        return false;
    if (env.CI === "true" || env.CI === "1")
        return false;
    return tty.stdin && tty.stdout;
}
