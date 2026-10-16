import { basename, dirname, isAbsolute } from "node:path";
import { command, quote } from "./process";
import { loadHosts, sshBinary, sshOptions, SshLink, REMOTE_PROTOCOL, type Hello } from "./hosts";
import type { HostConfig } from "./types";

export interface HostUpdate {
  name: string; current?: string; target: string;
  status: "current" | "available" | "busy" | "updated" | "failed" | "uncertain";
  detail?: string;
}
export interface UpgradeIO {
  hello(name: string, config: HostConfig): Promise<Hello>;
  activity(config: HostConfig, supportsTeams: boolean): Promise<string[]>;
  install(config: HostConfig, version: string): Promise<void>;
}
function remotePath(path: string) { return path.startsWith("~/") ? `"$HOME"/${quote(path.slice(2))}` : quote(path); }
async function ssh(config: HostConfig, script: string, timeoutMs = 30000) {
  const r = await command([sshBinary(), ...sshOptions(), config.ssh, script], { timeoutMs });
  if (r.code) throw new Error(`SSH exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}
function semver(value: string): number[] {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`invalid release version ${value}`);
  return value.split(".").map(Number);
}
function newer(a: string, b: string) {
  const x = semver(a), y = semver(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
export function installHostScript(config: HostConfig, version: string): string {
  semver(version);
  if (!isAbsolute(config.bin) && !config.bin.startsWith("~/")) throw new Error("host upgrade needs an absolute or ~/ bin path");
  if (basename(config.bin) !== "sflow") throw new Error("host bin must end in /sflow; install a custom executable name manually");
  // Download the installer at the SAME tag as the binary. No latest lookup on the host.
  return `set -eu
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
curl -fsSL ${quote(`https://raw.githubusercontent.com/leeguooooo/session-flow/v${version}/install.sh`)} -o "$stage/install.sh"
SFLOW_VERSION=${quote(version)} SFLOW_INSTALL_DIR=${remotePath(dirname(config.bin))} SFLOW_INSTALL_SKILLS=1 sh "$stage/install.sh"
`;
}
const defaultIO: UpgradeIO = {
  hello: (name, config) => new SshLink(name, config).call<Hello>("hello", {}, 20000),
  async activity(config, supportsTeams) {
    const bin = remotePath(config.bin);
    const runs = JSON.parse(await ssh(config, `${bin} runs --limit 9007199254740991 --json`));
    if (!Array.isArray(runs.runs) || !Array.isArray(runs.broken)) throw new Error("invalid run inventory");
    const busy: string[] = runs.runs.filter((r: any) => r.driver === "live" || !["done", "cancelled"].includes(r.status) || r.open?.length)
      .map((r: any) => `run ${r.id} (${r.status})`);
    if (runs.broken.length) busy.push(`${runs.broken.length} unreadable run record(s)`);
    if (supportsTeams) {
      const members = JSON.parse(await ssh(config, `${bin} team ls --json`));
      if (!Array.isArray(members)) throw new Error("invalid team inventory");
      busy.push(...members.filter((m: any) => m.status !== "closed").map((m: any) => `team member ${m.role} (${m.status})`));
    }
    return busy;
  },
  async install(config, version) { await ssh(config, installHostScript(config, version), 300000); },
};

// Planning never installs. Applying rechecks activity immediately before replacing each binary;
// it never stops workers, downgrades, retries a lost installer receipt, or rolls back other hosts.
export async function upgradeHosts(target: string, names: string[], apply: boolean,
  hosts = loadHosts(), io: UpgradeIO = defaultIO): Promise<HostUpdate[]> {
  semver(target);
  const selected = names.length ? [...new Set(names)] : Object.keys(hosts).sort();
  for (const name of selected) if (!hosts[name]) throw new Error(`unknown host ${name}`);
  const rows: HostUpdate[] = [];
  for (const name of selected) {
    const config = hosts[name], row: HostUpdate = { name, target, status: "failed" };
    rows.push(row);
    let installing = false;
    try {
      let h = await io.hello(name, config);
      row.current = h.version;
      if (h.version === target) {
        if (h.protocol !== REMOTE_PROTOCOL || (!newer("0.8.0", target) &&
          ["command-input-none", "command-check"].some(c => !h.capabilities?.includes(c))))
          throw new Error(`same version reports unexpected protocol/capabilities; inspect the installation`);
        row.status = "current"; continue;
      }
      if (newer(h.version, target)) throw new Error("host is newer than this driver; upgrade the driver first (no downgrade performed)");
      if (!["darwin", "linux"].includes(h.platform) || !["arm64", "x64"].includes(h.arch)) throw new Error(`unsupported host ${h.platform}/${h.arch}`);
      installHostScript(config, target); // Validate paths/version even for a plan.
      const busy = [...h.slots.map(s => s.owner), ...await io.activity(config, !newer("0.7.0", h.version))];
      if (busy.length) { row.status = "busy"; row.detail = busy.join("; "); continue; }
      row.status = "available";
      if (!apply) continue;
      // A plan is not permission to interrupt a worker that started since it was read.
      h = await io.hello(name, config);
      const recheck = [...h.slots.map(s => s.owner), ...await io.activity(config, !newer("0.7.0", h.version))];
      if (h.version !== row.current || recheck.length) { row.status = "busy"; row.detail = recheck.join("; ") || "installation changed since the check"; continue; }
      installing = true;
      await io.install(config, target);
      const after = await io.hello(name, config);
      if (after.version !== target || after.protocol !== REMOTE_PROTOCOL || ["command-input-none", "command-check"].some(c => !after.capabilities?.includes(c)))
        throw new Error(`post-install verification failed: version ${after.version}, protocol ${after.protocol}`);
      row.status = "updated";
    } catch (e) {
      row.status = installing ? "uncertain" : "failed";
      row.detail = `${(e as Error).message}${installing ? "; inspect with sflow hosts check; no automatic retry" : ""}`;
    }
  }
  return rows;
}
export function hostUpdateFailed(rows: HostUpdate[]) {
  return rows.some(r => ["busy", "failed", "uncertain"].includes(r.status));
}
export function renderHostUpdates(rows: HostUpdate[]): string[] {
  return rows.length ? rows.map(r => `${r.name}: ${r.status} ${r.current ?? "?"} -> ${r.target}${r.detail ? ` (${r.detail})` : ""}`) : ["no configured hosts"];
}
