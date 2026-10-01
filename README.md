# rn-build-cache

Skip the 20–40 minute Android Gradle build of a React Native / Expo app whenever the native side
has not changed. The same command works on a laptop (with an interactive terminal UI) and in
GitHub Actions (plain logs), and both share one cache stored on a GitHub release.

- **Debug / dev-client builds** with the same native fingerprint are reused as they are, because
  they load their JS from Metro.
- **Release builds** with the same native fingerprint get the current commit's JS bundled,
  compiled to Hermes bytecode and swapped into a copy of the cached APK, which is then zipaligned
  and re-signed. That takes minutes.
- Anything a swap cannot handle safely falls back to a full build, and that build becomes the new
  cache entry.

Expo prebuild projects are the main target. Bare React Native works for the cases noted below.

## Install

From GitHub; there is no npm release yet. Pin a tag:

```bash
bun add -d github:polygon-mv/rn-build-cache#v0.1.0
npm i -D github:polygon-mv/rn-build-cache#v0.1.0
```

This provides the `rn-build-cache` binary, which runs on Node ≥ 20 or Bun. `dist/` is committed,
so nothing builds at install time. `@expo/fingerprint` is resolved from your app: it comes with
`expo`, and a bare app adds it as a devDependency.

Requirements on the machine that builds: the Android SDK (`ANDROID_HOME`, with build-tools ≥ 30
for `zipalign` and `apksigner`), a JDK, `zip` and `unzip`, and `gh` (authenticated) for the shared
cache. `ccache` is optional; it is used for C++ when present.

## Configure

Put `rn-build-cache.config.mjs` (or `.js`, `.json`, or `.ts` under Bun or Node ≥ 23.6) at the
repo root or the app root. The tool searches upward from the working directory.

```js
/** @type {import("@polygon-mv/rn-build-cache").Config} */
export default {
  appDir: "apps/mobile", // relative to this file
  abi: "arm64-v8a",
  variants: {
    dev: {
      buildType: "debug",
      env: { APP_ENV: "development" },
      description: "Dev client (loads JS from Metro)",
    },
    staging: {
      buildType: "release",
      env: { APP_ENV: "staging" },
      envFile: ".env.staging", // fills in missing keys; relative to appDir
      envDefaults: { EXPO_PUBLIC_API_URL: "https://staging.example.com" },
      gradleArgs: ["--no-daemon", "--max-workers=2", "-x", "lintVitalRelease"],
      prepare: [
        // run from the config's directory before JS is bundled; skipped when the path exists
        { run: ["bun", "run", "build:i18n"], unlessExists: "packages/i18n/dist/index.js" },
      ],
    },
  },
  // Optional:
  // signing: { keystore: "android/app/debug.keystore", storePassword, keyAlias, keyPassword },
  // prebuild: true,                       // default: true when the app depends on expo
  // keyExtras: { gradle: "v2" },          // anything else to key on; change it to invalidate
  // remote: { repo: "owner/name", tag: "native-build-cache", keepPerVariant: 8, enabled: true },
  // local: { dir: "~/.cache/rn-build-cache", keep: 3 },
};
```

`signing` must be the key your release build type signs with. A swapped APK is re-signed with it,
so it installs over a Gradle-built one. Debug builds are never re-signed.

## Use it locally

```bash
bunx rn-build-cache                       # interactive: pick a variant and options, watch it run
bunx rn-build-cache --variant staging     # plain output, for scripts
bunx rn-build-cache --variant dev --install --device <serial>
```

The interactive UI asks for a variant, whether to skip the cache, and whether to install. While
it runs, it shows each phase live with its elapsed time and the latest line of tool output:
fingerprint, local cache, remote cache, then either bundle and swap or prebuild and Gradle, then
store and upload. At the end it shows the hit or miss, the time saved and the APK path, and offers
`adb install -r` on a connected device. It never sets up adb networking, so USB works as is. The
full output of the run goes to `~/.cache/rn-build-cache/last-build.log`.

The UI appears only when stdin and stdout are terminals, `CI` is not set, and no `--variant` was
given. `--plain` forces plain output.

| flag                       | effect                                                                       |
| -------------------------- | ---------------------------------------------------------------------------- |
| `--variant <name>`         | a variant from the config; also selects plain output                         |
| `--install [--device id]`  | `adb install -r` the result                                                  |
| `--out <path>`             | APK destination (default `android/app/build/outputs/rn-build-cache/<v>.apk`) |
| `--no-cache`               | skip the lookup; the build still refreshes the cache                         |
| `--no-remote`              | local cache only                                                             |
| `--upload` / `--no-upload` | share a fresh build on the release (default: CI only)                        |
| `--cache-only`             | build from the cache or do nothing (exit 0, `hit=false`); never runs Gradle  |
| `--prepare`                | run every prepare step, even ones whose output exists                        |
| `--explain`                | print what the cache key is made of                                          |

## Use it in GitHub Actions

Run it twice: once with `--cache-only`, then a full build only on a miss. That way the expensive
runner setup (freeing disk, ccache and Gradle caches) is skipped on a hit:

```yaml
permissions:
  contents: write # the cache release
jobs:
  android:
    runs-on: ubuntu-latest
    env:
      GH_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: "17" }
      - run: bun install --frozen-lockfile
      - name: Build from native cache
        id: cached
        run: bunx rn-build-cache --variant staging --cache-only
      # ...free disk, restore ccache / Gradle caches: `if: steps.cached.outputs.hit != 'true'`
      - name: Full native build
        id: full
        if: steps.cached.outputs.hit != 'true'
        run: bunx rn-build-cache --variant staging --no-cache
      - run: echo "APK at ${{ steps.cached.outputs.apk || steps.full.outputs.apk }}"
```

Step outputs: `hit` (`true`/`false`), `cache` (`hit`, `swap`, `miss` or `none`), `key`, `apk`.
A summary line is appended to the job summary. In CI (`CI=true`) fresh builds are uploaded by
default.

## How it works

**Key.** `@expo/fingerprint` hashes the app's native inputs: `android/`, config plugins,
autolinked modules and the evaluated app config. The tool leaves out two things that change on
every commit without affecting native code: the config's `extra` section (often a build stamp)
and `package.json` scripts. The key is a SHA-256 over that fingerprint plus the variant, the ABI,
the `react-native` and `hermes-compiler` versions, a recipe version and your `keyExtras`. The
fingerprint is taken **before** prebuild, because prebuild rewrites tracked `android/` files and
the key would otherwise move between lookup and store. In Expo apps `.env*` loading is turned off
(`EXPO_NO_DOTENV`), so a developer's `.env.local` cannot change a release bundle or the key.

**Lookup.** The local cache comes first (`~/.cache/rn-build-cache/<key>/`, least recently used
entries pruned). Then one GitHub release, by default tagged `native-build-cache`, holding
`<key>.apk` and `<key>.json` assets. A remote hit is copied into the local cache. A remote that is
down or unauthenticated is noted and skipped; it never fails the build.

Why releases and not the Actions cache: release assets are free, readable from a laptop, and
shared across branches. An Actions cache saved on a feature branch is invisible to other
branches, unavailable locally, and capped at 10 GB per repo. Keep the Actions cache for ccache
and Gradle on a miss. Everything lives on one release because a release per fingerprint would
push real releases down the list. This one is created once and sinks below them over time.

**Release JS swap.** Up to three APK entries change per commit, and the tool rewrites each one
that is present:

| entry                         | regenerated with                                                                       | why it matters                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `assets/index.android.bundle` | `export:embed` (Expo) or `react-native bundle`, then `hermesc -O`, stored uncompressed | the JS itself; Hermes mmaps it                                                                                                            |
| `assets/app.config`           | expo-constants `getAppConfig.js`                                                       | `Constants.expoConfig`, including `extra`                                                                                                 |
| `assets/app.manifest`         | the cached manifest with a **new `id`** and `commitTime`                               | expo-updates copies the embedded update keyed by `id`; with an old id, a device that ran the previous APK keeps launching the previous JS |

Then `zipalign -P 16 -f 4` (16 KB page alignment) and `apksigner sign` plus `verify`.

**Safety fallbacks.** The swap refuses and a full build runs when:

- the JS asset set differs: an image or font imported from JS was added, changed or removed.
  These are compiled by AAPT into `res/` with shortened paths and a `resources.arsc` row, which
  only Gradle can produce. They are compared by hashing the freshly emitted `res/` tree against
  the tree recorded when the entry was built;
- the Hermes bytecode version of the new bundle differs from the cached one (read from the HBC
  header). A mismatched runtime would crash on launch;
- the entry has no asset record, or any step fails: bundling, hermesc, expo-constants, zip,
  zipalign or apksigner.

Native changes need no check of their own, because they change the fingerprint and therefore the
key.

**Miss.** The tool runs `expo prebuild` (Expo apps), then `./gradlew <task>
-PreactNativeArchitectures=<abi> --build-cache …gradleArgs`. It uses ccache for C++ when
installed and retries twice on failure, since Maven flakes are common. If `android/` was clean
before prebuild, the tool restores it afterwards. The APK is stored together with the build time
(the baseline for "time saved"), the emitted asset hashes, the HBC version and the fingerprint
sources. The next miss uses those sources to name what changed.

## Caveats

- A dirty `android/` or a `node_modules` out of step with the lockfile gives a different key than
  CI does. That is a miss, never a wrong hit. `--explain` and the miss line show why.
- Bare React Native: the swap handles the bundle. An app whose APK embeds `app.config` needs
  `expo-constants` installed. Only the Android build is cached; iOS is not handled.
- Bump a `keyExtras` value when you change Gradle flags that alter the output.

## Develop

```bash
bun install
bun run test && bun run typecheck && bun run check
bun run build   # dist/ is committed: rebuild before tagging (CI checks it is current)
```

MIT licensed.
