/**
 * Cache lookup order: this machine first, then the shared remote.
 *
 * A remote hit is copied into the local store before use, so the next build on this machine (or
 * a retry after a CI `--cache-only` step) is a local hit. A remote that is down or
 * unauthenticated is a note, never a failure: the build just runs.
 */

import type { CacheMeta } from "./meta.js";

export interface CacheEntry {
  readonly meta: CacheMeta;
  /** A path the caller may read; for the local store it is the stored file itself. */
  readonly apkPath: string;
}

export interface CacheStore {
  readonly name: string;
  get(key: string): Promise<CacheEntry | null>;
}

export interface LocalStore extends CacheStore {
  /** Copies an entry in (from a remote download or a fresh build) and returns the stored copy. */
  put(meta: CacheMeta, apkPath: string): Promise<CacheEntry>;
}

export type LookupResult =
  | {
      readonly hit: true;
      readonly source: string;
      readonly entry: CacheEntry;
      readonly notes: string[];
    }
  | { readonly hit: false; readonly notes: string[] };

/** Progress hooks, so a caller can show each tier as it is consulted. */
export interface LookupEvents {
  localDone?(hit: boolean): void;
  remoteStart?(store: CacheStore): void;
  remoteDone?(store: CacheStore, hit: boolean): void;
  remoteFailed?(store: CacheStore, reason: string): void;
}

export async function lookup(
  key: string,
  local: LocalStore,
  remotes: readonly CacheStore[],
  events: LookupEvents = {},
): Promise<LookupResult> {
  const notes: string[] = [];
  const own = await local.get(key);
  events.localDone?.(own !== null);
  if (own) return { hit: true, source: local.name, entry: own, notes };

  for (const remote of remotes) {
    let found: CacheEntry | null;
    events.remoteStart?.(remote);
    try {
      found = await remote.get(key);
    } catch (error) {
      const reason = `${remote.name} unavailable (${describe(error)}); continuing without it`;
      notes.push(reason);
      events.remoteFailed?.(remote, reason);
      continue;
    }
    events.remoteDone?.(remote, found !== null && found.meta.key === key);
    if (!found) continue;
    if (found.meta.key !== key) {
      notes.push(`${remote.name} returned an entry for ${found.meta.key}, not ${key}; ignoring it`);
      continue;
    }
    const stored = await local.put(found.meta, found.apkPath);
    return { hit: true, source: remote.name, entry: stored, notes };
  }
  return { hit: false, notes };
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split("\n")[0] ?? error.name;
  return String(error);
}
