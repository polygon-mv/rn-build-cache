/**
 * The interactive UI: @clack/prompts for the questions, and a small live renderer for the build
 * phases (status, elapsed time, the latest line of child output). Child output goes to a log file
 * instead of the terminal so the view stays readable.
 */
import * as p from "@clack/prompts";
import type { ResolvedConfig } from "./config.js";
import type { Reporter } from "./reporter.js";
declare const color: {
    dim: (s: string) => string;
    green: (s: string) => string;
    red: (s: string) => string;
    cyan: (s: string) => string;
    bold: (s: string) => string;
};
export interface Choices {
    readonly variant: string;
    readonly cache: boolean;
    readonly install: boolean;
}
/** Asks for the variant and options. Returns null when the user cancels. */
export declare function ask(config: ResolvedConfig): Promise<Choices | null>;
/** A Reporter that redraws a phase list in place. Call `stop()` before printing anything else. */
export declare function createLiveReporter(logPath: string): Reporter & {
    stop(): void;
};
export interface Device {
    readonly serial: string;
    readonly name: string;
}
/** Devices `adb devices -l` lists as ready (USB or otherwise; this tool never sets up networking). */
export declare function listDevices(): Device[];
export declare function parseAdbDevices(output: string): Device[];
/** Picks the device to install on, or null to skip. `asked` = the user already chose to install. */
export declare function chooseDevice(asked: boolean): Promise<Device | null>;
export { p as prompts, color };
