/**
 * Child-process helpers. Long steps stream: to the terminal in plain mode, or line by line into
 * the active output sink (the TUI's log file and live status line).
 */
export interface RunOptions {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
}
type Sink = (line: string) => void;
/** Route child output (null = inherit the terminal) and notes (default: stderr). Used by the TUI. */
export declare function setOutput(next: {
    sink: Sink | null;
    log?: (message: string) => void;
}): void;
/** Runs a command; rejects on a non-zero exit. */
export declare function run(command: string, args: readonly string[], options: RunOptions): Promise<void>;
/** Runs a short command and returns its trimmed stdout; throws with stderr on failure. */
export declare function capture(command: string, args: readonly string[], options: RunOptions): string;
/** True when `command` resolves on PATH. */
export declare function onPath(command: string): boolean;
export declare function log(message: string): void;
export declare function formatDuration(ms: number): string;
export {};
