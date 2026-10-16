import { test, expect } from "bun:test";
import { upgradeHosts, installHostScript, hostUpdateFailed, type UpgradeIO } from "../src/host-upgrade";
import { parseHost, REMOTE_PROTOCOL, type Hello } from "../src/hosts";
const config = parseHost("mini", { ssh: "mini" });
const hello = (version = "0.7.1"): Hello => ({ version, protocol: REMOTE_PROTOCOL, home: "/state", platform: "darwin", arch: "arm64", cpus: 4,
  load: 0, freeGB: 10, tools: {}, slots: [], capabilities: ["command-input-none", "command-check"] });
function fixture() {
  const versions: Record<string, string> = { mini: "0.7.1", other: "0.7.1" }, installs: string[] = [];
  const io: UpgradeIO = {
    async hello(name) { return hello(versions[name]); }, async activity() { return []; },
    async install(c, version) { installs.push(c.ssh); versions[c.ssh] = version; },
  };
  return { io, installs, versions };
}
test("host check is install-free, and apply pins and verifies the exact driver version", async () => {
  const { io, installs } = fixture();
  expect((await upgradeHosts("0.8.0", [], false, { mini: config }, io))[0].status).toBe("available");
  expect(installs).toEqual([]);
  expect((await upgradeHosts("0.8.0", [], true, { mini: config }, io))[0].status).toBe("updated");
  expect(installs).toEqual(["mini"]);
  expect((await upgradeHosts("0.8.0", [], true, { mini: config }, io))[0].status).toBe("current");
  expect(installs).toEqual(["mini"]);
  const script = installHostScript(config, "0.8.0");
  expect(script).toContain("/v0.8.0/install.sh");
  expect(script).toContain("SFLOW_VERSION='0.8.0'");
  expect(script).not.toContain("latest");
  expect(script).toContain('SFLOW_INSTALL_DIR="$HOME"/');
  expect(() => installHostScript(config, "0.8.0; touch x")).toThrow("invalid release version");
});
test("busy slots, unresolved records, and activity that starts after the plan prevent installation", async () => {
  const { io, installs } = fixture();
  io.hello = async () => ({ ...hello(), slots: [{ owner: "job:busy" }] });
  expect((await upgradeHosts("0.8.0", [], true, { mini: config }, io))[0].status).toBe("busy");
  io.hello = async () => hello();
  io.activity = async () => ["uncertain run"];
  expect((await upgradeHosts("0.8.0", [], true, { mini: config }, io))[0].status).toBe("busy");
  let checks = 0;
  io.activity = async () => ++checks === 1 ? [] : ["new team member"];
  expect((await upgradeHosts("0.8.0", [], true, { mini: config }, io))[0].status).toBe("busy");
  expect(installs).toEqual([]);
});
test("an uncertain installer is not retried; other hosts and partial results stay explicit", async () => {
  const { io, installs, versions } = fixture();
  io.install = async (c, target) => { installs.push(c.ssh); if (c.ssh === "mini") throw new Error("SSH lost after replace"); versions[c.ssh] = target; };
  const rows = await upgradeHosts("0.8.0", [], true, { mini: config, other: parseHost("other", { ssh: "other" }) }, io);
  expect(rows.map(r => r.status)).toEqual(["uncertain", "updated"]);
  expect(rows[0].detail).toContain("no automatic retry");
  expect(installs).toEqual(["mini", "other"]);
  expect(hostUpdateFailed(rows)).toBe(true);
});
test("offline hosts, unverified replacement and a newer host never report success or downgrade", async () => {
  const { io, installs } = fixture();
  io.hello = async () => { throw new Error("offline"); };
  expect((await upgradeHosts("0.8.0", [], true, { mini: config }, io))[0].status).toBe("failed");
  io.hello = async () => hello("0.9.0");
  expect((await upgradeHosts("0.8.0", [], true, { mini: config }, io))[0].detail).toContain("no downgrade");
  expect(installs).toEqual([]);
  io.hello = async () => hello();
  expect((await upgradeHosts("0.8.0", [], true, { mini: config }, io))[0].status).toBe("uncertain");
  expect(installs).toEqual(["mini"]);
});

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { quote } from "../src/process";

test("SSH upgrade composes the real pinned installer, custom host home, checksum and final hello", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-host-install-")), saved = { ...process.env };
  try {
    const home = join(root, "remote-home"), tools = join(root, "tools"), destination = join(home, ".local/bin"), payload = join(root, "payload");
    for (const p of [home, tools, destination, payload]) mkdirSync(p, { recursive: true });
    const archive = `sflow-${process.platform}-${process.arch}.tar.gz`;
    const binary = (version: string) => `#!/bin/sh
case "$1:$2" in
  version:*) echo ${version};;
  remote:hello) echo ${quote(JSON.stringify({ ...hello(version), home: join(home, "state"), platform: process.platform, arch: process.arch }))};;
  runs:*) echo '{"runs":[],"broken":[]}' ;;
  team:ls) echo '[]';;
  skill:install) echo installed;;
  *) exit 1;;
esac
`;
    writeFileSync(join(destination, "sflow"), binary("0.7.1")); chmodSync(join(destination, "sflow"), 0o755);
    writeFileSync(join(payload, "sflow"), binary("0.8.0")); chmodSync(join(payload, "sflow"), 0o755);
    expect(spawnSync("tar", ["-czf", join(root, archive), "-C", payload, "sflow"]).status).toBe(0);
    writeFileSync(join(root, "checksum"), `${createHash("sha256").update(readFileSync(join(root, archive))).digest("hex")}  ${archive}\n`);
    writeFileSync(join(tools, "curl"), `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -o) output="$2"; shift 2;; https:*) url="$1"; shift;; *) shift;; esac; done
printf '%s\\n' "$url" >> ${quote(join(root, "urls"))}
case "$url" in */install.sh) cp ${quote(resolve(import.meta.dir, "../install.sh"))} "$output";; *.sha256) cp ${quote(join(root, "checksum"))} "$output";; *) cp ${quote(join(root, archive))} "$output";; esac
`); chmodSync(join(tools, "curl"), 0o755);
    const ssh = join(root, "ssh");
    writeFileSync(ssh, `#!/bin/sh
while [ $# -gt 1 ]; do case "$1" in -o) shift 2;; *) break;; esac; done
shift
export HOME=${quote(home)} SFLOW_HOME=${quote(join(home, "state"))} PATH=${quote(`${tools}:/usr/bin:/bin`)}
exec sh -c "$*"
`); chmodSync(ssh, 0o755); process.env.SFLOW_SSH_BIN = ssh;
    expect((await upgradeHosts("0.8.0", [], false, { mini: config }))[0].status).toBe("available");
    expect(readFileSync(join(destination, "sflow"), "utf8")).toContain("0.7.1");
    const rows = await upgradeHosts("0.8.0", [], true, { mini: config });
    expect(rows[0]).toMatchObject({ status: "updated", current: "0.7.1", target: "0.8.0" });
    expect(readFileSync(join(root, "urls"), "utf8")).toContain("/v0.8.0/install.sh");
    expect(readFileSync(join(root, "urls"), "utf8")).toContain("/releases/download/v0.8.0/");
    expect(readFileSync(join(root, "urls"), "utf8")).not.toContain("latest");
  } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); rmSync(root, { recursive: true, force: true }); }
});
