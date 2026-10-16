import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

test("installer pins the release, verifies before replacing, and keeps the old executable on a bad download", () => {
  const root = mkdtempSync(join(tmpdir(), "sf-install-"));
  try {
    const bin = join(root, "bin"), payload = join(root, "payload"), destination = join(root, "installed");
    for (const dir of [bin, payload, destination]) mkdirSync(dir);
    const archive = `sflow-${process.platform}-${process.arch}.tar.gz`, tarball = join(root, archive), checksum = join(root, "checksum");
    function pack(version: string, corrupt = false) {
      writeFileSync(join(payload, "sflow"), `#!/bin/sh\necho ${version}\n`); chmodSync(join(payload, "sflow"), 0o755);
      expect(spawnSync("tar", ["-czf", tarball, "-C", payload, "sflow"]).status).toBe(0);
      writeFileSync(checksum, `${corrupt ? "0".repeat(64) : createHash("sha256").update(readFileSync(tarball)).digest("hex")}  ${archive}\n`);
    }
    writeFileSync(join(bin, "curl"), `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -o) output="$2"; shift 2;; https:*) url="$1"; shift;; *) shift;; esac; done
printf '%s\\n' "$url" >> "$FIXTURE/urls"
case "$url" in *.sha256) cp "$FIXTURE/checksum" "$output";; *) cp "$FIXTURE/${archive}" "$output";; esac
`); chmodSync(join(bin, "curl"), 0o755);
    const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, FIXTURE: root, SFLOW_VERSION: "0.8.0", SFLOW_INSTALL_DIR: destination, SFLOW_INSTALL_SKILLS: "0" };
    const run = () => spawnSync("sh", [resolve(import.meta.dir, "../install.sh")], { env, encoding: "utf8" });
    writeFileSync(join(destination, "sflow"), "old executable");
    pack("0.8.0", true);
    expect(run().status).not.toBe(0);
    expect(readFileSync(join(destination, "sflow"), "utf8")).toBe("old executable");
    pack("0.7.1");
    expect(run().status).not.toBe(0);
    expect(readFileSync(join(destination, "sflow"), "utf8")).toBe("old executable");
    pack("0.8.0");
    expect(run().status).toBe(0);
    expect(spawnSync(join(destination, "sflow"), ["version"], { encoding: "utf8" }).stdout.trim()).toBe("0.8.0");
    expect(readFileSync(join(root, "urls"), "utf8")).toContain("/releases/download/v0.8.0/");
    expect(readFileSync(join(root, "urls"), "utf8")).not.toContain("latest");
    env.SFLOW_VERSION = "0.8.0;echo bad";
    expect(run().status).not.toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
