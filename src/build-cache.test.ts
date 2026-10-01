import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, wantsInteractive } from "./args.js";
import { buildEnv } from "./build.js";
import { summarize } from "./cli.js";
import { resolveConfig, type ResolvedVariant } from "./config.js";
import { ccacheSummary } from "./gradle-build.js";
import { compareDotted } from "./swap.js";
import { parseAdbDevices } from "./tui.js";
import { entriesToPrune } from "./github-store.js";
import { cacheKey, keyMaterial, variantOfKey, type KeyInputs } from "./key.js";
import { lookup, type CacheEntry, type CacheStore, type LocalStore } from "./lookup.js";
import { META_SCHEMA, parseMeta, type CacheMeta } from "./meta.js";
import { decideSwap, diffAssets, hbcVersion } from "./swap-safety.js";

const INPUTS: KeyInputs = {
  fingerprint: "33477a809b3844899985b4a7f5b9ce34249b43e6",
  variant: "staging",
  abi: "arm64-v8a",
  hermesCompiler: "250829098.0.10",
  reactNative: "0.86.3",
};

function meta(overrides: Partial<CacheMeta> = {}): CacheMeta {
  return {
    schema: META_SCHEMA,
    key: cacheKey(INPUTS),
    variant: "staging",
    abi: "arm64-v8a",
    fingerprint: INPUTS.fingerprint,
    commit: "b6e5bf76",
    builtAt: "2026-10-01T04:36:31.086Z",
    buildSeconds: 1900,
    apkSha256: "a".repeat(64),
    apkBytes: 104_536_931,
    assets: { "drawable-mdpi/logo.png": "h1", "raw/font.ttf": "h2" },
    hbcVersion: 98,
    sources: [],
    ...overrides,
  };
}

describe("cache key", () => {
  test("is stable and prefixed with the variant", () => {
    const key = cacheKey(INPUTS);
    expect(key).toBe(cacheKey({ ...INPUTS }));
    expect(key).toMatch(/^staging-[0-9a-f]{24}$/);
    expect(variantOfKey(key)).toBe("staging");
  });

  test("moves with every input", () => {
    const base = cacheKey(INPUTS);
    const changes: Partial<KeyInputs>[] = [
      { fingerprint: "0".repeat(40) },
      { variant: "dev" },
      { extras: { gradle: "--max-workers=2" } },
      { abi: "x86_64" },
      { hermesCompiler: "250829098.0.11" },
      { reactNative: "0.87.0" },
      { recipe: 999 },
    ];
    for (const change of changes) expect(cacheKey({ ...INPUTS, ...change })).not.toBe(base);
  });

  test("does not depend on property order", () => {
    const reordered = Object.fromEntries(Object.entries(INPUTS).reverse()) as unknown as KeyInputs;
    expect(keyMaterial(reordered)).toBe(keyMaterial(INPUTS));
  });

  test("refuses an empty input rather than hashing it", () => {
    expect(() => cacheKey({ ...INPUTS, fingerprint: "" })).toThrow(/fingerprint/);
  });

  test("variantOfKey rejects names this tool did not write", () => {
    expect(variantOfKey("staging-2026-10-01-b6e5bf76")).toBeNull();
    expect(variantOfKey("clarity-staging-android")).toBeNull();
  });
});

describe("swap safety", () => {
  const header = (version: number) => {
    const bytes = new Uint8Array(12);
    bytes.set([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);
    new DataView(bytes.buffer).setUint32(8, version, true);
    return bytes;
  };

  test("reads the Hermes bytecode version from the header", () => {
    expect(hbcVersion(header(98))).toBe(98);
    // The real header of the staging APK this was written against.
    expect(
      hbcVersion(Uint8Array.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f, 0x62, 0, 0, 0])),
    ).toBe(98);
  });

  test("plain JS is not Hermes bytecode", () => {
    expect(hbcVersion(new TextEncoder().encode("var __BUNDLE_START"))).toBeNull();
    expect(hbcVersion(new Uint8Array(4))).toBeNull();
  });

  test("diffAssets reports added, changed and removed paths", () => {
    expect(diffAssets({ a: "1", b: "2", c: "9" }, { a: "1", b: "3", d: "4" })).toEqual({
      added: ["c"],
      changed: ["b"],
      removed: ["d"],
    });
  });

  test("allows a swap when only the JS changed", () => {
    expect(decideSwap(meta(), { assets: { ...meta().assets }, hbcVersion: 98 })).toEqual({
      safe: true,
    });
  });

  test("refuses when an image was added, changed or removed", () => {
    const cached = meta().assets as Record<string, string>;
    for (const assets of <Record<string, string>[]>[
      { ...cached, "drawable-xhdpi/new.png": "h3" },
      { ...cached, "drawable-mdpi/logo.png": "different" },
      { "raw/font.ttf": "h2" },
    ]) {
      const decision = decideSwap(meta(), { assets, hbcVersion: 98 });
      expect(decision.safe).toBe(false);
      if (!decision.safe) expect(decision.reason).toContain("asset set differs");
    }
  });

  test("refuses on a Hermes bytecode version mismatch", () => {
    const decision = decideSwap(meta(), { assets: { ...meta().assets }, hbcVersion: 99 });
    expect(decision.safe).toBe(false);
    if (!decision.safe) expect(decision.reason).toContain("v99");
  });

  test("refuses an entry without an asset manifest or bytecode version", () => {
    expect(decideSwap(meta({ assets: null }), { assets: {}, hbcVersion: 98 }).safe).toBe(false);
    expect(
      decideSwap(meta({ hbcVersion: null }), { assets: { ...meta().assets }, hbcVersion: 98 }).safe,
    ).toBe(false);
    expect(decideSwap(meta(), { assets: { ...meta().assets }, hbcVersion: null }).safe).toBe(false);
  });
});

describe("cache lookup order", () => {
  const entry = (m: CacheMeta, apkPath: string): CacheEntry => ({ meta: m, apkPath });

  function fakeLocal(initial: CacheEntry[] = []) {
    const stored = new Map(initial.map((e) => [e.meta.key, e]));
    const calls: string[] = [];
    const store: LocalStore = {
      name: "local",
      async get(key) {
        calls.push(`local.get ${key}`);
        return stored.get(key) ?? null;
      },
      async put(m, apkPath) {
        calls.push(`local.put ${apkPath}`);
        const copy = entry(m, `/local/${m.key}.apk`);
        stored.set(m.key, copy);
        return copy;
      },
    };
    return { store, calls };
  }

  function fakeRemote(name: string, found: CacheEntry | null | Error, calls: string[]): CacheStore {
    return {
      name,
      async get(key) {
        calls.push(`${name}.get ${key}`);
        if (found instanceof Error) throw found;
        return found;
      },
    };
  }

  test("a local hit never touches the remote", async () => {
    const m = meta();
    const { store, calls } = fakeLocal([entry(m, "/local/a.apk")]);
    const result = await lookup(m.key, store, [fakeRemote("remote", null, calls)]);
    expect(result.hit && result.source).toBe("local");
    expect(calls).toEqual([`local.get ${m.key}`]);
  });

  test("a remote hit is copied into the local store and served from there", async () => {
    const m = meta();
    const { store, calls } = fakeLocal();
    const result = await lookup(m.key, store, [
      fakeRemote("remote", entry(m, "/tmp/dl.apk"), calls),
    ]);
    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.source).toBe("remote");
      expect(result.entry.apkPath).toBe(`/local/${m.key}.apk`);
    }
    expect(calls).toEqual([`local.get ${m.key}`, `remote.get ${m.key}`, "local.put /tmp/dl.apk"]);
    // The next lookup is local.
    const again = await lookup(m.key, store, []);
    expect(again.hit && again.source).toBe("local");
  });

  test("a failing remote is a note, and the next remote is still asked", async () => {
    const m = meta();
    const { store, calls } = fakeLocal();
    const result = await lookup(m.key, store, [
      fakeRemote("flaky", new Error("HTTP 502"), calls),
      fakeRemote("backup", entry(m, "/tmp/b.apk"), calls),
    ]);
    expect(result.hit && result.source).toBe("backup");
    expect(result.notes[0]).toContain("flaky unavailable (HTTP 502)");
  });

  test("an entry recorded under another key is ignored", async () => {
    const m = meta();
    const { store, calls } = fakeLocal();
    const result = await lookup("staging-000000000000000000000000", store, [
      fakeRemote("remote", entry(m, "/x.apk"), calls),
    ]);
    expect(result.hit).toBe(false);
    expect(result.notes[0]).toContain("ignoring");
  });

  test("everything missing is a miss", async () => {
    const { store, calls } = fakeLocal();
    expect(
      (await lookup("dev-111111111111111111111111", store, [fakeRemote("remote", null, calls)]))
        .hit,
    ).toBe(false);
  });
});

describe("meta", () => {
  test("round-trips and rejects other shapes", () => {
    expect(parseMeta(JSON.stringify(meta()))?.key).toBe(meta().key);
    expect(parseMeta("{")).toBeNull();
    expect(parseMeta(JSON.stringify({ ...meta(), schema: 2 }))).toBeNull();
    expect(parseMeta(JSON.stringify({ tagName: "staging-2026-10-01" }))).toBeNull();
  });
});

describe("remote pruning", () => {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const key = (variant: string, n: number) => `${variant}-${String(n).padStart(24, "0")}`;

  test("keeps the newest entries per variant and drops stale orphans", () => {
    const assets = [
      ...[1, 2, 3].flatMap((n) => [
        { name: `${key("staging", n)}.apk`, createdAt: at(100 - n) },
        { name: `${key("staging", n)}.json`, createdAt: at(100 - n) },
      ]),
      { name: `${key("dev", 1)}.apk`, createdAt: at(10) },
      { name: `${key("dev", 1)}.json`, createdAt: at(10) },
      { name: `${key("dev", 2)}.apk`, createdAt: at(120) }, // orphan, stale
      { name: `${key("dev", 3)}.apk`, createdAt: at(5) }, // orphan, maybe mid-upload
      { name: "clarity-staging-android.apk", createdAt: at(1000) }, // not ours
    ];
    expect(entriesToPrune(assets, 2).sort()).toEqual(
      [`${key("staging", 1)}.apk`, `${key("staging", 1)}.json`, `${key("dev", 2)}.apk`].sort(),
    );
  });
});

describe("arguments", () => {
  test("defaults: cached, remote, upload only in CI", () => {
    const local = parseArgs(["--variant", "staging"], {});
    expect(local).toMatchObject({ variant: "staging", cache: true, remote: true, upload: false });
    expect(parseArgs(["--variant=dev"], { CI: "true" })).toMatchObject({
      variant: "dev",
      upload: true,
    });
    expect(parseArgs([], {})).toMatchObject({ variant: null, config: null });
  });

  test("accepts the run-script separator and flags", () => {
    expect(
      parseArgs(["--", "--variant", "dev", "--install", "--device", "R5C", "--no-cache"], {}),
    ).toMatchObject({ install: true, device: "R5C", cache: false });
    expect(parseArgs(["--config", "x.json", "--plain"], {})).toMatchObject({
      config: "x.json",
      plain: true,
    });
  });

  test("rejects bad input and contradictory flags", () => {
    expect(parseArgs(["--variant"], {})).toHaveProperty("error");
    expect(parseArgs(["--variant", "dev", "--cache-only", "--no-cache"], {})).toHaveProperty(
      "error",
    );
    expect(parseArgs(["--variant", "dev", "--bogus"], {})).toHaveProperty("error");
  });
});

describe("interactive or plain", () => {
  const tty = { stdin: true, stdout: true };
  const opts = { variant: null, plain: false };

  test("interactive only for a person at a terminal with no variant", () => {
    expect(wantsInteractive(opts, {}, tty)).toBe(true);
    expect(wantsInteractive({ ...opts, variant: "dev" }, {}, tty)).toBe(false);
    expect(wantsInteractive({ ...opts, plain: true }, {}, tty)).toBe(false);
    expect(wantsInteractive(opts, { CI: "true" }, tty)).toBe(false);
    expect(wantsInteractive(opts, {}, { stdin: true, stdout: false })).toBe(false);
    expect(wantsInteractive(opts, {}, { stdin: false, stdout: true })).toBe(false);
  });
});

describe("config", () => {
  const base = { variants: { dev: { buildType: "debug" }, staging: { buildType: "release" } } };

  test("fills in defaults relative to the config file", () => {
    const config = resolveConfig(
      { ...base, appDir: "apps/mobile" },
      "/repo/rn-build-cache.config.mjs",
    );
    expect(config.root).toBe("/repo");
    expect(config.appDir).toBe("/repo/apps/mobile");
    expect(config.abi).toBe("arm64-v8a");
    expect(config.signing.keystore).toBe("/repo/apps/mobile/android/app/debug.keystore");
    expect(config.remote).toEqual({
      enabled: true,
      repo: null,
      tag: "native-build-cache",
      keepPerVariant: 8,
    });
    const staging = config.variants.staging;
    expect(staging?.gradleTask).toBe(":app:assembleRelease");
    expect(staging?.apkPath).toBe("app/build/outputs/apk/release/app-release.apk");
    expect(staging?.embedsJs).toBe(true);
    expect(config.variants.dev?.embedsJs).toBe(false);
  });

  test("rejects configs it cannot use", () => {
    expect(() => resolveConfig(null, "/c.json")).toThrow(/object/);
    expect(() => resolveConfig({ variants: {} }, "/c.json")).toThrow(/at least one/);
    expect(() => resolveConfig({ variants: { Dev: { buildType: "debug" } } }, "/c.json")).toThrow(
      /lowercase/,
    );
    expect(() => resolveConfig({ variants: { dev: { buildType: "profile" } } }, "/c.json")).toThrow(
      /buildType/,
    );
  });

  test("env precedence: defaults < env file < environment < variant env", () => {
    const dir = mkdtempSync(join(tmpdir(), "rnbc-"));
    writeFileSync(
      join(dir, ".env.staging"),
      "# c\nURL=from-file\nexport QUOTED='q'\nONLY_FILE=f\n",
    );
    const config = resolveConfig(
      {
        prebuild: true,
        variants: {
          staging: {
            buildType: "release",
            envDefaults: { URL: "default", ONLY_DEFAULT: "d" },
            envFile: ".env.staging",
            env: { APP_ENV: "staging" },
          },
        },
      },
      join(dir, "rn-build-cache.config.json"),
    );
    const saved = { ...process.env };
    process.env.APP_ENV = "development";
    try {
      const env = buildEnv(config, config.variants.staging as ResolvedVariant);
      expect(env.URL).toBe("from-file");
      expect(env.QUOTED).toBe("q");
      expect(env.ONLY_DEFAULT).toBe("d");
      expect(env.APP_ENV).toBe("staging");
      expect(env.EXPO_NO_DOTENV).toBe("1");
    } finally {
      process.env = saved;
    }
  });
});

describe("output helpers", () => {
  test("adb device listing keeps ready devices only", () => {
    const out = `List of devices attached
R5CT1234ABC    device usb:1-1 product:a55 model:SM_A556E device:a55x transport_id:3
emulator-5554  offline
ZY22 unauthorized usb:1-2
`;
    expect(parseAdbDevices(out)).toEqual([
      { serial: "R5CT1234ABC", name: "SM A556E (R5CT1234ABC)" },
    ]);
    expect(parseAdbDevices("List of devices attached\n")).toEqual([]);
  });

  test("ccache stats summary", () => {
    expect(ccacheSummary("direct_cache_hit\t90\npreprocessed_cache_hit\t5\ncache_miss\t5\n")).toBe(
      "ccache 95/100 hits",
    );
    expect(ccacheSummary("")).toBe("ccache: no C++ compiled");
  });

  test("summary line says hit or miss and the time saved", () => {
    const result = {
      key: "staging-0123456789abcdef01234567",
      apkPath: "/x.apk",
      source: "GitHub release native-build-cache",
      fallbackReason: null,
      elapsedMs: 180_000,
    };
    expect(summarize("staging", { ...result, outcome: "swap", baselineSeconds: 1800 })).toContain(
      "HIT (GitHub release native-build-cache; native reused, this commit's JS swapped in) in 3m00s, saved ~27m00s of a 30m00s build",
    );
    expect(summarize("dev", { ...result, outcome: "miss", baselineSeconds: null })).toContain(
      "MISS",
    );
    expect(
      summarize("staging", {
        ...result,
        outcome: "none",
        baselineSeconds: null,
        fallbackReason: "the JS asset set differs",
      }),
    ).toContain("not building (--cache-only)");
  });

  test("build-tools versions sort numerically", () => {
    expect(["9.0.0", "36.1.0", "36.0.0", "35.0.0-rc1"].sort(compareDotted)).toEqual([
      "9.0.0",
      "35.0.0-rc1",
      "36.0.0",
      "36.1.0",
    ]);
  });
});
