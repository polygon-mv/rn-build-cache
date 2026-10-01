/**
 * The interactive UI: @clack/prompts for the questions, and a small live renderer for the build
 * phases (status, elapsed time, the latest line of child output). Child output goes to a log file
 * instead of the terminal so the view stays readable.
 */

import { createWriteStream, type WriteStream } from "node:fs";
import * as p from "@clack/prompts";
import type { ResolvedConfig } from "./config.js";
import { capture, formatDuration, onPath, setOutput } from "./exec.js";
import type { PhaseId, PhaseState, Reporter } from "./reporter.js";

const color = {
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
};

export interface Choices {
  readonly variant: string;
  readonly cache: boolean;
  readonly install: boolean;
}

/** Asks for the variant and options. Returns null when the user cancels. */
export async function ask(config: ResolvedConfig): Promise<Choices | null> {
  p.intro(color.bold(" rn-build-cache "));
  const variant = await p.select({
    message: "What do you want to build?",
    options: Object.values(config.variants).map((v) => ({
      value: v.name,
      label: v.name,
      hint: v.description,
    })),
  });
  if (p.isCancel(variant)) return cancelled();
  const options = await p.multiselect({
    message: "Options",
    required: false,
    options: [
      { value: "no-cache", label: "Skip the cache", hint: "full Gradle build" },
      { value: "install", label: "Install on a USB device when done", hint: "adb install -r" },
    ],
    initialValues: [] as string[],
  });
  if (p.isCancel(options)) return cancelled();
  return {
    variant,
    cache: !options.includes("no-cache"),
    install: options.includes("install"),
  };
}

function cancelled(): null {
  p.cancel("Cancelled.");
  return null;
}

interface Row {
  id: PhaseId;
  label: string;
  state: PhaseState;
  detail: string;
  startedAt: number;
  endedAt: number | null;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** A Reporter that redraws a phase list in place. Call `stop()` before printing anything else. */
export function createLiveReporter(logPath: string): Reporter & { stop(): void } {
  const rows: Row[] = [];
  const logFile: WriteStream = createWriteStream(logPath, { flags: "w" });
  let drawn = 0;
  let frame = 0;
  let stopped = false;
  const out = process.stdout;

  const row = (id: PhaseId): Row => {
    let found = rows.find((r) => r.id === id);
    if (!found) {
      found = { id, label: id, state: "pending", detail: "", startedAt: Date.now(), endedAt: null };
      rows.push(found);
    }
    return found;
  };
  const running = () => [...rows].reverse().find((r) => r.state === "running");

  const render = () => {
    if (stopped) return;
    const width = Math.max(40, (out.columns ?? 100) - 2);
    const lines: string[] = [];
    for (const r of rows) {
      const elapsed = formatDuration((r.endedAt ?? Date.now()) - r.startedAt);
      const icon =
        r.state === "running"
          ? color.cyan(SPINNER[frame % SPINNER.length] as string)
          : r.state === "done"
            ? color.green("✓")
            : r.state === "failed"
              ? color.red("✗")
              : color.dim("–");
      const time = r.state === "skipped" ? "" : color.dim(elapsed);
      lines.push(`${icon} ${r.state === "skipped" ? color.dim(r.label) : r.label}  ${time}`);
      if (r.detail) lines.push(`  ${color.dim(truncate(r.detail, width - 2))}`);
    }
    out.write(`${drawn > 0 ? `\x1b[${drawn}F` : ""}\x1b[0J${lines.join("\n")}\n`);
    drawn = lines.length;
    frame++;
  };

  const timer = setInterval(render, 120);
  out.write("\x1b[?25l");
  const restoreCursor = () => out.write("\x1b[?25h");
  process.once("exit", restoreCursor);

  setOutput({
    sink: (line) => {
      logFile.write(`${line}\n`);
      const current = running();
      const text = line.trim();
      if (current && text) current.detail = text;
    },
    log: (message) => {
      logFile.write(`[rn-build-cache] ${message}\n`);
    },
  });

  const end = (id: PhaseId, state: PhaseState, detail?: string) => {
    const r = row(id);
    r.state = state;
    r.endedAt = Date.now();
    r.detail = detail ?? "";
    render();
  };

  return {
    start(id, label) {
      const r = row(id);
      Object.assign(r, {
        label,
        state: "running",
        detail: "",
        startedAt: Date.now(),
        endedAt: null,
      });
      render();
    },
    progress(id, detail) {
      row(id).detail = detail;
    },
    done: (id, detail) => end(id, "done", detail),
    fail: (id, detail) => end(id, "failed", detail),
    skip(id, detail) {
      const r = row(id);
      if (r.label === id) r.label = defaultLabel(id);
      end(id, "skipped", detail);
    },
    stop() {
      if (stopped) return;
      render();
      stopped = true;
      clearInterval(timer);
      restoreCursor();
      logFile.end();
      setOutput({ sink: null });
    },
  };
}

function defaultLabel(id: PhaseId): string {
  const labels: Record<PhaseId, string> = {
    fingerprint: "Fingerprint native inputs",
    "lookup-local": "Local cache",
    "lookup-remote": "Remote cache",
    prepare: "Prepare workspace",
    bundle: "Bundle JS",
    swap: "Swap into cached APK",
    prebuild: "expo prebuild",
    gradle: "Gradle build",
    store: "Store in the local cache",
    upload: "Upload to the remote cache",
    install: "Install",
  };
  return labels[id];
}

function truncate(text: string, width: number): string {
  // oxlint-disable-next-line no-control-regex -- strips ANSI colour codes from child output
  const plain = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  return plain.length > width ? `${plain.slice(0, width - 1)}…` : plain;
}

export interface Device {
  readonly serial: string;
  readonly name: string;
}

/** Devices `adb devices -l` lists as ready (USB or otherwise; this tool never sets up networking). */
export function listDevices(): Device[] {
  if (!onPath("adb")) return [];
  try {
    return parseAdbDevices(capture("adb", ["devices", "-l"], { cwd: process.cwd() }));
  } catch {
    return [];
  }
}

export function parseAdbDevices(output: string): Device[] {
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => /^\S+\s+device\b/.test(line))
    .map((line) => {
      const serial = line.split(/\s+/)[0] as string;
      const model = /model:(\S+)/.exec(line)?.[1]?.replace(/_/g, " ");
      return { serial, name: model ? `${model} (${serial})` : serial };
    });
}

/** Picks the device to install on, or null to skip. `asked` = the user already chose to install. */
export async function chooseDevice(asked: boolean): Promise<Device | null> {
  const devices = listDevices();
  if (devices.length === 0) {
    if (asked) p.log.warn("No adb device is connected — plug the phone in over USB and run again.");
    return null;
  }
  if (devices.length === 1) {
    const only = devices[0] as Device;
    if (asked) return only;
    const yes = await p.confirm({ message: `Install on ${only.name}?`, initialValue: true });
    return yes === true ? only : null;
  }
  const picked = await p.select({
    message: "Install on which device?",
    options: [
      ...devices.map((d) => ({ value: d.serial, label: d.name })),
      { value: "", label: "Don't install" },
    ],
  });
  if (p.isCancel(picked) || picked === "") return null;
  return devices.find((d) => d.serial === picked) ?? null;
}

export { p as prompts, color };
