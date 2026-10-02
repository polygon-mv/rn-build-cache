/**
 * `rn-build-cache` — an Android APK, from cache whenever the native side has not changed.
 * Interactive in a terminal, plain in CI or with `--variant`. See README.md.
 */
import { type BuildResult, type CheckResult } from "./build.js";
export declare function main(argv: readonly string[]): Promise<number>;
/** The one line a person or a log scraper reads: what happened, how long, how much it saved. */
export declare function summarize(variant: string, result: BuildResult): string;
export declare function summarizeCheck(variant: string, result: CheckResult): string;
