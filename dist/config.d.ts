/**
 * The consuming project's config: `rn-build-cache.config.{mjs,js,json}` (or `.ts` when the runtime
 * can import TypeScript — Bun, Node ≥ 23.6). Everything app-specific lives here; the tool knows no
 * app names, paths or flavors of its own.
 */
/** A command to run before bundling (workspace packages, codegen…). */
export interface PrepareStep {
    /** argv, run from the repo root. */
    readonly run: readonly string[];
    /** Skip the step when this path (relative to the repo root) exists, unless `--prepare` is passed. */
    readonly unlessExists?: string;
}
export interface VariantConfig {
    /** Gradle build type. Debug APKs load JS from Metro and are reused verbatim; release embeds it. */
    readonly buildType: "debug" | "release";
    /** Env set for every step (fingerprint, prebuild, bundling, Gradle), e.g. `{ APP_ENV: "staging" }`. */
    readonly env?: Readonly<Record<string, string>>;
    /** Env used only when neither the environment nor `envFile` sets it. */
    readonly envDefaults?: Readonly<Record<string, string>>;
    /** Dotenv file (relative to the app dir) whose `EXPO_PUBLIC_*` keys fill in what the env lacks. */
    readonly envFile?: string;
    /** Default `:app:assemble<BuildType>`. */
    readonly gradleTask?: string;
    /** Extra Gradle arguments (workers, memory, `-x lintVitalRelease`…). */
    readonly gradleArgs?: readonly string[];
    /** Default `app/build/outputs/apk/<buildType>/app-<buildType>.apk`, relative to android/. */
    readonly apkPath?: string;
    /** Steps that must run before JS is bundled (in a swap, or inside Gradle). */
    readonly prepare?: readonly PrepareStep[];
    /** Human label for the interactive picker. */
    readonly description?: string;
    /**
     * Pass `--reset-cache` to Metro when a swap bundles JS (default true, as the RN Gradle plugin
     * does). Set false to reuse Metro's transform cache between swaps, e.g. a CI cache of
     * `$TMPDIR/metro-cache`: bundling is most of a swap. Metro's cache key does not cover every
     * env value a Babel plugin inlines, so key such a persisted cache on those values.
     */
    readonly resetMetroCache?: boolean;
}
export interface Config {
    /** The React Native app, relative to the config file. Default `.`. */
    readonly appDir?: string;
    /** Default `arm64-v8a`. A cache entry is only reused for the same ABI. */
    readonly abi?: string;
    readonly variants: Readonly<Record<string, VariantConfig>>;
    /** Re-signing a swapped release APK. Default: android/app/debug.keystore, android/androiddebugkey. */
    readonly signing?: {
        readonly keystore?: string;
        readonly storePassword?: string;
        readonly keyAlias?: string;
        readonly keyPassword?: string;
    };
    /** Run `expo prebuild` before Gradle. Default: true when the app depends on `expo`. */
    readonly prebuild?: boolean;
    /**
     * Extra strings folded into the cache key (bump one to invalidate every entry), on top of the
     * fingerprint, variant, ABI, react-native and hermes-compiler versions.
     */
    readonly keyExtras?: Readonly<Record<string, string>>;
    readonly remote?: {
        /** `owner/name`. Default: the repo `gh` infers from the git remote. */
        readonly repo?: string;
        /** Release tag holding the cache. Default `native-build-cache`. */
        readonly tag?: string;
        /** Entries kept per variant. Default 8. */
        readonly keepPerVariant?: number;
        /** Set false to use the local cache only. */
        readonly enabled?: boolean;
    };
    readonly local?: {
        /** Default `~/.cache/rn-build-cache` (or `$RN_BUILD_CACHE_DIR`). */
        readonly dir?: string;
        /** Entries kept on this machine. Default 3. */
        readonly keep?: number;
    };
}
/** Identity helper for typed configs. */
export declare function defineConfig(config: Config): Config;
export declare const CONFIG_NAMES: readonly ["rn-build-cache.config.mjs", "rn-build-cache.config.js", "rn-build-cache.config.json", "rn-build-cache.config.ts"];
/** Finds the config in `from` or the nearest parent directory. */
export declare function findConfig(from: string): string | null;
export interface ResolvedVariant extends Required<Omit<VariantConfig, "description" | "envFile">> {
    readonly name: string;
    readonly description: string;
    readonly envFile: string | null;
    readonly embedsJs: boolean;
}
export interface ResolvedConfig {
    readonly configPath: string;
    /** Directory of the config file; prepare steps and git run here. */
    readonly root: string;
    readonly appDir: string;
    readonly abi: string;
    readonly variants: Readonly<Record<string, ResolvedVariant>>;
    readonly signing: {
        readonly keystore: string;
        readonly storePassword: string;
        readonly keyAlias: string;
        readonly keyPassword: string;
    };
    readonly prebuild: boolean;
    readonly keyExtras: Readonly<Record<string, string>>;
    readonly remote: {
        readonly enabled: boolean;
        readonly repo: string | null;
        readonly tag: string;
        readonly keepPerVariant: number;
    };
    readonly local: {
        readonly dir: string | null;
        readonly keep: number;
    };
}
export declare function loadConfig(path: string): Promise<ResolvedConfig>;
/** Validates a raw config object and fills in defaults. Throws with a readable message. */
export declare function resolveConfig(raw: unknown, configPath: string): ResolvedConfig;
export declare function dependsOnExpo(appDir: string): boolean;
