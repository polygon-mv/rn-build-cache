/**
 * Build phases as events, so the same orchestration drives plain CI logs and the live TUI.
 */
import { formatDuration, log } from "./exec.js";
/** One line per transition on stderr; child output goes straight to the terminal. */
export function createPlainReporter() {
    const started = new Map();
    const took = (phase) => {
        const start = started.get(phase);
        return start ? ` (${formatDuration(Date.now() - start.at)})` : "";
    };
    const label = (phase) => started.get(phase)?.label ?? phase;
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
export async function phase(reporter, id, label, body, detail) {
    reporter.start(id, label);
    try {
        const value = await body();
        reporter.done(id, detail?.(value));
        return value;
    }
    catch (error) {
        reporter.fail(id, error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error));
        throw error;
    }
}
