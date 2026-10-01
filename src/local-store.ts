/**
 * The per-machine cache: `~/.cache/rn-build-cache/<key>/{app.apk,meta.json}`.
 *
 * Least-recently-used entries are pruned after every store. A release APK is typically 50-150 MB,
 * so the default keeps only a few.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CacheEntry, LocalStore } from "./lookup.js";
import { parseMeta, type CacheMeta } from "./meta.js";

export function defaultCacheDir(): string {
  return process.env.RN_BUILD_CACHE_DIR ?? join(homedir(), ".cache", "rn-build-cache");
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export function createLocalStore(root: string): LocalStore & {
  prune(keep: number, protect: string): Promise<string[]>;
} {
  const dirOf = (key: string) => join(root, key);

  return {
    name: `local cache (${root})`,

    async get(key) {
      const dir = dirOf(key);
      let meta: CacheMeta | null;
      try {
        meta = parseMeta(await readFile(join(dir, "meta.json"), "utf8"));
      } catch {
        return null;
      }
      const apkPath = join(dir, "app.apk");
      const size = await stat(apkPath).then(
        (s) => s.size,
        () => -1,
      );
      if (!meta || meta.key !== key || size !== meta.apkBytes) return null;
      const now = new Date();
      await utimes(join(dir, "meta.json"), now, now).catch(() => undefined);
      return { meta, apkPath };
    },

    async put(meta, apkPath): Promise<CacheEntry> {
      const dir = dirOf(meta.key);
      await mkdir(dir, { recursive: true });
      const target = join(dir, "app.apk");
      if (apkPath !== target) {
        await copyFile(apkPath, `${target}.partial`);
        await rename(`${target}.partial`, target);
      }
      // meta.json last: its presence is what makes the entry visible to `get`.
      await writeFile(`${join(dir, "meta.json")}.partial`, JSON.stringify(meta, null, 2));
      await rename(`${join(dir, "meta.json")}.partial`, join(dir, "meta.json"));
      return { meta, apkPath: target };
    },

    async prune(keep, protect) {
      const names = await readdir(root).catch(() => [] as string[]);
      const entries = await Promise.all(
        names.map(async (name) => {
          const used = await stat(join(root, name, "meta.json")).then(
            (s) => s.mtimeMs,
            () => 0,
          );
          return { name, used };
        }),
      );
      const removable = entries
        .filter((entry) => entry.name !== protect)
        .sort((a, b) => b.used - a.used)
        .slice(Math.max(0, keep - 1));
      for (const entry of removable)
        await rm(join(root, entry.name), { recursive: true, force: true });
      return removable.map((entry) => entry.name);
    },
  };
}
