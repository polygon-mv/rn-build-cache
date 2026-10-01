/**
 * What a cache entry records beside its APK (`<key>.json`).
 *
 * Uploaded after the APK, so a remote entry whose JSON exists is complete.
 */

export const META_SCHEMA = 1;

export interface FingerprintSourceSummary {
  /** File or dir path, or the id of a contents source (e.g. `expoConfig`). */
  readonly id: string;
  readonly hash: string | null;
}

export interface CacheMeta {
  readonly schema: typeof META_SCHEMA;
  readonly key: string;
  readonly variant: string;
  readonly abi: string;
  readonly fingerprint: string;
  /** The commit whose native side this APK was built from (its JS may be swapped since). */
  readonly commit: string;
  readonly builtAt: string;
  /** Wall time of the full build that produced the entry; the baseline for "time saved". */
  readonly buildSeconds: number;
  readonly apkSha256: string;
  readonly apkBytes: number;
  /**
   * sha256 per file Metro emitted into `res/` (relative path → hash) for an embedded-JS variant.
   * Null when the variant does not embed JS, or the build output was missing: a swap then refuses.
   */
  readonly assets: Readonly<Record<string, string>> | null;
  /** Hermes bytecode version of the embedded bundle, or null when not Hermes / not embedded. */
  readonly hbcVersion: number | null;
  /** Fingerprint sources, so a miss can say what moved. */
  readonly sources: readonly FingerprintSourceSummary[];
}

export function parseMeta(text: string): CacheMeta | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const meta = raw as Partial<CacheMeta>;
  if (meta.schema !== META_SCHEMA) return null;
  if (typeof meta.key !== "string" || typeof meta.apkSha256 !== "string") return null;
  if (typeof meta.buildSeconds !== "number" || !Array.isArray(meta.sources)) return null;
  return meta as CacheMeta;
}
