import { spawn } from "node:child_process";
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { configHome, writeJSON } from "./templates";
import { quote } from "./process";
import type { HostConfig } from "./types";

// Driver and host must agree on this number; it changes with any remote operation's contract.
export const REMOTE_PROTOCOL = 2;
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
export const DEFAULTS = { bin: "~/.local/bin/sflow", slots: 2, maxLoad: 0.8, minFreeGB: 5 } as const;

export function hostsFile(): string { return join(configHome(), "hosts.json"); }
export function parseHost(name: string, value: unknown): HostConfig {
  if (!NAME.test(name)) throw new Error(`invalid host name ${name}`);
  if (name === "any" || name === "local") throw new Error(`${name} is reserved`);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`hosts.${name}: expected an object`);
  const o = value as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["ssh", "bin", "slots", "maxLoad", "minFreeGB", "site", "tags"].includes(k)) throw new Error(`hosts.${name}: unknown field ${k}`);
  // The target goes to ssh as one argument; an option-looking value would be read as a flag.
  if (typeof o.ssh !== "string" || !/^[\w.@%:\[\]-]+$/.test(o.ssh) || o.ssh.startsWith("-")) throw new Error(`hosts.${name}: ssh must be a target like user@host or a ~/.ssh/config alias`);
  if (o.bin !== undefined && (typeof o.bin !== "string" || !/^[\w~/.+-]+$/.test(o.bin))) throw new Error(`hosts.${name}: bin must be a plain path`);
  const num = (k: string, min: number, max: number, int: boolean) => {
    const v = o[k];
    if (v !== undefined && (typeof v !== "number" || v < min || v > max || (int && !Number.isInteger(v)))) throw new Error(`hosts.${name}: ${k} must be ${int ? "an integer " : ""}${min}..${max}`);
  };
  num("slots", 1, 64, true); num("maxLoad", 0.05, 16, false); num("minFreeGB", 0, 10000, false);
  if (o.site !== undefined && (typeof o.site !== "string" || !NAME.test(o.site))) throw new Error(`hosts.${name}: invalid site`);
  if (o.tags !== undefined && (!Array.isArray(o.tags) || o.tags.some(t => typeof t !== "string" || !NAME.test(t)))) throw new Error(`hosts.${name}: invalid tags`);
  return { ssh: o.ssh, bin: (o.bin as string) ?? DEFAULTS.bin, slots: (o.slots as number) ?? DEFAULTS.slots, maxLoad: (o.maxLoad as number) ?? DEFAULTS.maxLoad,
    minFreeGB: (o.minFreeGB as number) ?? DEFAULTS.minFreeGB, ...(o.site ? { site: o.site as string } : {}), ...(o.tags ? { tags: o.tags as string[] } : {}) };
}
export function loadHosts(): Record<string, HostConfig> {
  const path = hostsFile();
  if (!existsSync(path)) return {};
  const o = JSON.parse(readFileSync(path, "utf8"));
  if (o?.version !== 1 || !o.hosts || typeof o.hosts !== "object") throw new Error(`${path}: expected {"version": 1, "hosts": {…}}`);
  return Object.fromEntries(Object.entries(o.hosts).map(([k, v]) => [k, parseHost(k, v)]));
}
export function saveHosts(hosts: Record<string, HostConfig>) { writeJSON(hostsFile(), { version: 1, hosts }, true); }

// The concrete host names a step may use, resolved against the configured hosts.
export function candidates(spec: string[], hosts: Record<string, HostConfig>): string[] {
  const names = spec.includes("any") ? Object.keys(hosts) : spec;
  for (const n of names) if (!hosts[n]) throw new Error(`unknown host ${n}; add it with: sflow hosts add ${n} --ssh <target>`);
  if (!names.length) throw new Error(`host "any" needs at least one host in ${hostsFile()}`);
  return [...new Set(names)].sort();
}

export interface Hello {
  protocol: number; version: string; home: string; arch: string; platform: string;
  cpus: number; load: number; freeGB: number; tools: Record<string, string | null>;
  slots: { owner: string; since?: number }[];
}
export interface Link {
  name: string;
  call<T = any>(op: string, input?: unknown, timeoutMs?: number): Promise<T>;
  // Streams a raw operation's stdout into a file (logs, artifacts, patches).
  fetch(op: string, input: unknown, file: string, timeoutMs?: number): Promise<void>;
  // A git remote URL for a path on the host, and the environment git needs to reach it.
  gitUrl(path: string): string;
  gitEnv(): Record<string, string>;
}

export function sshBinary(): string { return process.env.SFLOW_SSH_BIN ?? "ssh"; }
// One shared connection per host for the driver's many short calls. macOS TMPDIR paths are too
// long for the socket, so it lives in /tmp, in a directory that must be ours and private; otherwise
// no sharing. Host key checking and the rest of the user's ssh config are untouched.
function controlDir(): string | undefined {
  const dir = join("/tmp", `sf-ssh-${process.getuid?.() ?? 0}`);
  try { mkdirSync(dir, { mode: 0o700 }); } catch {}
  try {
    const st = lstatSync(dir);
    if (st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o077) === 0 && st.uid === process.getuid?.()) return dir;
  } catch {}
  return undefined;
}
export function sshOptions(): string[] {
  const dir = controlDir();
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
    ...(dir ? ["-o", "ControlMaster=auto", "-o", `ControlPath=${join(dir, "%C")}`, "-o", "ControlPersist=120"] : [])];
}
// "~/x" is expanded by the remote shell; anything else is quoted.
function remoteWord(path: string): string { return path.startsWith("~/") ? `"$HOME"/${quote(path.slice(2))}` : quote(path); }

abstract class ProcessLink implements Link {
  abstract name: string;
  protected abstract argv(op: string): string[];
  abstract gitUrl(path: string): string;
  abstract gitEnv(): Record<string, string>;
  protected failure(code: number | null, msg: string): string { return `${this.name}: ${msg.replace(/^sflow: /, "")}`; }
  private run(op: string, input: unknown, timeoutMs: number, sink?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const argv = this.argv(op);
      const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "", settled = false;
      const temp = sink ? `${sink}.part` : undefined, file = temp ? createWriteStream(temp, { mode: 0o600 }) : undefined;
      const done = (e?: Error) => { if (settled) return; settled = true; clearTimeout(timer); e ? reject(e) : resolve(out); };
      const timer = setTimeout(() => { child.kill("SIGKILL"); done(new Error(`${this.name}: remote ${op} timed out; its outcome is unknown`)); }, timeoutMs);
      child.stdout.on("data", d => { if (file) file.write(d); else { out += d; if (out.length > 16 * 1024 * 1024) child.kill(); } });
      child.stderr.on("data", d => { err += d; });
      child.on("error", e => done(new Error(`${this.name}: cannot run ssh: ${e.message}`)));
      child.on("close", code => {
        const finish = () => {
          if (code === 0) { if (temp && sink) renameSync(temp, sink); return done(); }
          if (temp && existsSync(temp)) unlinkSync(temp);
          const msg = err.trim().split("\n").filter(Boolean).pop() ?? `exit ${code}`;
          done(new Error(this.failure(code, msg)));
        };
        if (file) file.end(finish); else finish();
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(input ?? {}));
    });
  }
  async call<T>(op: string, input?: unknown, timeoutMs = 60_000): Promise<T> {
    const out = await this.run(op, input, timeoutMs);
    try { return JSON.parse(out) as T; } catch { throw new Error(`${this.name}: remote ${op} returned no JSON (is it a current sflow?)`); }
  }
  async fetch(op: string, input: unknown, file: string, timeoutMs = 600_000) { await this.run(op, input, timeoutMs, file); }
}
export class SshLink extends ProcessLink {
  constructor(readonly name: string, readonly config: HostConfig) { super(); }
  protected argv(op: string) { return [sshBinary(), ...sshOptions(), this.config.ssh, `${remoteWord(this.config.bin)} remote ${quote(op)}`]; }
  // 255 is ssh's own failure (unreachable, auth); anything else came from sflow on the host.
  protected failure(code: number | null, msg: string) { return code === 255 ? `${this.name}: ssh ${this.config.ssh} failed: ${msg}` : super.failure(code, msg); }
  gitUrl(path: string) { return `${this.config.ssh}:${path}`; }
  gitEnv() { return { GIT_SSH_COMMAND: [sshBinary(), ...sshOptions()].map(quote).join(" ") }; }
}
// This machine, through the same operations: local command steps share the job journal.
export class LocalLink extends ProcessLink {
  readonly name = "local";
  constructor(readonly cli: string[]) { super(); }
  protected argv(op: string) { return [...this.cli, "remote", op]; }
  gitUrl(path: string) { return path; }
  gitEnv() { return {}; }
}

// Probes a host, answering why it cannot take work now (or null when it can).
export function unfit(name: string, config: HostConfig, hello: Hello): string | null {
  if (hello.protocol !== REMOTE_PROTOCOL) return `${name} runs sflow ${hello.version} (remote protocol ${hello.protocol}, this driver needs ${REMOTE_PROTOCOL}); install the same sflow there`;
  const perCore = hello.load / Math.max(1, hello.cpus);
  if (perCore > config.maxLoad) return `${name} is busy (load ${hello.load.toFixed(1)} on ${hello.cpus} cores, limit ${config.maxLoad} per core)`;
  if (hello.freeGB < config.minFreeGB) return `${name} has ${hello.freeGB.toFixed(1)} GB free, under its minFreeGB ${config.minFreeGB}`;
  return null;
}
