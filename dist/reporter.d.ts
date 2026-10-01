/**
 * Build phases as events, so the same orchestration drives plain CI logs and the live TUI.
 */
export type PhaseId = "fingerprint" | "lookup-local" | "lookup-remote" | "prepare" | "bundle" | "swap" | "prebuild" | "gradle" | "store" | "upload" | "install";
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
export declare function createPlainReporter(): Reporter;
/** Wraps a phase: start, run, done or fail (and rethrow). */
export declare function phase<T>(reporter: Reporter, id: PhaseId, label: string, body: () => Promise<T>, detail?: (value: T) => string | undefined): Promise<T>;
