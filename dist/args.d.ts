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
export declare const USAGE = "Usage: rn-build-cache [--variant <name>] [options]\n\nRun without --variant in a terminal for the interactive UI.\n\n  --variant <name>       a variant from rn-build-cache.config (e.g. dev, staging)\n  --install              adb install -r the result (add --device <serial> with several devices)\n  --out <path>           where to write the APK\n  --no-cache             skip the lookup and build; the result still refreshes the cache\n  --no-remote            use only the local cache, never the GitHub release\n  --upload / --no-upload share a fresh build on the GitHub release (default: on in CI only)\n  --cache-only           build from the cache or do nothing (exit 0, hit=false); never Gradle\n  --prepare              run every prepare step, even ones whose output already exists\n  --config <path>        config file (default: nearest rn-build-cache.config.* upwards)\n  --explain              print what the cache key is made of\n  --plain                no interactive UI, even in a terminal";
export declare function parseArgs(argv: readonly string[], env?: Readonly<Record<string, string | undefined>>): CliOptions | {
    error: string;
} | {
    help: true;
};
/**
 * The interactive UI only when a person is clearly at the keyboard: a TTY on both ends, not CI,
 * and no variant given (a variant on the command line means a script or a habit — run it).
 */
export declare function wantsInteractive(options: Pick<CliOptions, "variant" | "plain">, env: Readonly<Record<string, string | undefined>>, tty: {
    stdin: boolean;
    stdout: boolean;
}): boolean;
