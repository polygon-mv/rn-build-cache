/**
 * Child-process helpers. Long steps stream: to the terminal in plain mode, or line by line into
 * the active output sink (the TUI's log file and live status line).
 */
import { spawn, spawnSync } from "node:child_process";
let sink = null;
const stderrLog = (message) => {
    process.stderr.write(`[rn-build-cache] ${message}\n`);
};
let logger = stderrLog;
/** Route child output (null = inherit the terminal) and notes (default: stderr). Used by the TUI. */
export function setOutput(next) {
    sink = next.sink;
    logger = next.log ?? stderrLog;
}
/** Runs a command; rejects on a non-zero exit. */
export function run(command, args, options) {
    log(`$ ${[command, ...args].join(" ")}`);
    return new Promise((resolve, reject) => {
        const current = sink;
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: current ? ["ignore", "pipe", "pipe"] : "inherit",
        });
        if (current) {
            for (const stream of [child.stdout, child.stderr]) {
                let buffer = "";
                stream?.setEncoding("utf8");
                stream?.on("data", (chunk) => {
                    buffer += chunk;
                    const lines = buffer.split(/\r?\n|\r/);
                    buffer = lines.pop() ?? "";
                    for (const line of lines)
                        current(line);
                });
                stream?.on("end", () => {
                    if (buffer)
                        current(buffer);
                });
            }
        }
        child.on("error", reject);
        child.on("exit", (code, signal) => {
            if (code === 0)
                resolve();
            else
                reject(new Error(`${command} ${args[0] ?? ""} exited with ${signal ?? code}`));
        });
    });
}
/** Runs a short command and returns its trimmed stdout; throws with stderr on failure. */
export function capture(command, args, options) {
    const result = spawnSync(command, args, {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error)
        throw result.error;
    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" | ");
        throw new Error(`${command} ${args.slice(0, 2).join(" ")} failed: ${detail}`);
    }
    return result.stdout.trim();
}
/** True when `command` resolves on PATH. */
export function onPath(command) {
    return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}
export function log(message) {
    logger(message);
}
export function formatDuration(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(seconds / 60);
    return minutes > 0 ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}
