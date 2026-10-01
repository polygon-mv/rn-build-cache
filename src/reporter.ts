/**
 * Build phases as events, so the same orchestration drives plain CI logs and the live TUI.
 */

import { formatDuration, log } from "./exec.js";

export type PhaseId =
  | "fingerprint"
  | "lookup-local"
  | "lookup-remote"
  | "prepare"
  | "bundle"
  | "swap"
  | "prebuild"
  | "gradle"
  | "store"
  | "upload"
  | "install";

export type PhaseState = "pending" | "running" | "done" | "skipped" | "failed";

export interface Reporter {
  start(phase: PhaseId, label: string): void;
  /** A progress line for the running phase (e.g. the current Gradle task). */
  progress(phase: PhaseId, detail: string): void;
  done(phase: PhaseId, detail?: string): void;
  skip(phase: PhaseId, detail: string): void;
  fail(phase: PhaseId, detail: string): void;
}

/** One line per transition on stderr; child output goes straight to the terminal. */
export function createPlainReporter(): Reporter {
  const started = new Map<PhaseId, { at: number; label: string }>();
  const took = (phase: PhaseId) => {
    const start = started.get(phase);
    return start ? ` (${formatDuration(Date.now() - start.at)})` : "";
  };
  const label = (phase: PhaseId) => started.get(phase)?.label ?? phase;
  return {
    start(phase, text) {
      started.set(phase, { at: Date.now(), label: text });
      log(`▸ ${text}`);
    },
    progress() {
      // Child output is already on the terminal.
    },
    done(phase, detail) {
      log(`✓ ${label(phase)}${took(phase)}${detail ? ` — ${detail}` : ""}`);
    },
    skip(phase, detail) {
      log(`- ${label(phase)}: ${detail}`);
    },
    fail(phase, detail) {
      log(`✗ ${label(phase)}${took(phase)}: ${detail}`);
    },
  };
}

/** Wraps a phase: start, run, done or fail (and rethrow). */
export async function phase<T>(
  reporter: Reporter,
  id: PhaseId,
  label: string,
  body: () => Promise<T>,
  detail?: (value: T) => string | undefined,
): Promise<T> {
  reporter.start(id, label);
  try {
    const value = await body();
    reporter.done(id, detail?.(value));
    return value;
  } catch (error) {
    reporter.fail(
      id,
      error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error),
    );
    throw error;
  }
}
