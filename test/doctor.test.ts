import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { doctor, renderChecks } from "../src/doctor";

const dir = mkdtempSync(join(tmpdir(), "sf-doctor-")), oldPath = process.env.PATH;
afterAll(() => { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); });
function fake(name: string, body: string) { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o700); return p; }

test("doctor reports versions, sign-in and the Pi extension without reading credentials", async () => {
  const tmux = fake("tmux", "echo tmux 3.5");
  const oldOcs = fake("ocs-old", "echo ocs 0.7.9"), ocs = fake("ocs", "echo ocs 0.8.3");
  fake("claude", `case "$1" in --version) echo "2.1 (Claude Code)";; auth) echo '{"loggedIn": false}';; esac`);
  fake("codex", `case "$1" in --version) echo codex-cli 1.0;; login) echo "Logged in using ChatGPT" >&2;; esac`);
  fake("pi", "echo 1.1.0");
  process.env.PATH = `${dir}:/usr/bin:/bin`;
  const home = join(dir, "home"); mkdirSync(home);

  const checks = await doctor({ tmux, ocs: oldOcs, agents: ["claude", "codex", "pi", "agy"], env: {}, home });
  const by = (name: string) => checks.find(c => c.name === name)!;
  expect(by("tmux").level).toBe("ok");
  expect(by("ocs")).toMatchObject({ level: "fail", fix: "ocs upgrade" });
  expect(by("claude login")).toMatchObject({ level: "fail", fix: "claude auth login" });
  expect(by("codex login").level).toBe("ok");
  expect(by("pi login").level).toBe("skip");
  expect(by("pi ocs extension")).toMatchObject({ level: "fail", fix: "ocs doctor --fix" });
  expect(by("agy")).toMatchObject({ level: "fail" });
  expect(renderChecks(checks).join("\n")).toContain("fix: claude auth login");

  mkdirSync(join(home, ".pi/agent/extensions"), { recursive: true }); writeFileSync(join(home, ".pi/agent/extensions/ocs.ts"), "");
  const unused = await doctor({ tmux, ocs, env: {}, home });
  expect(unused.find(c => c.name === "ocs")!.level).toBe("ok");
  expect(unused.find(c => c.name === "agy")!.level).toBe("skip"); // not needed when no workflow names it
  expect(unused.find(c => c.name === "claude login")!.level).toBe("warn");
  expect(unused.find(c => c.name === "pi ocs extension")!.level).toBe("ok");
});
