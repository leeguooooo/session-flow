import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preflight, requiredTools } from "../src/preflight";

test("preflight lists every missing tool with how to install it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-preflight-"));
  try {
    const tools = requiredTools(join(dir, "tmux"), join(dir, "ocs"), ["claude", "claude", "no-such-agent-cli"]);
    expect(tools.map(t => t.name)).toEqual(["tmux", "ocs", "claude", "no-such-agent-cli"]);
    const err = await preflight(tools.filter(t => t.name !== "claude")).catch((e: Error) => e.message);
    expect(err).toContain("nothing was created");
    expect(err).toContain("tmux not found");
    expect(err).toContain("brew install tmux");
    expect(err).toContain("SFLOW_TMUX_BIN");
    expect(err).toContain("ocs not found");
    expect(err).toContain("open-cross-session/main/install.sh");
    expect(err).toContain("no-such-agent-cli not found");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("preflight passes working tools and reports a broken one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-preflight-"));
  const ok = join(dir, "tmux"), bad = join(dir, "ocs");
  writeFileSync(ok, "#!/bin/sh\necho tmux 3.5\n"); chmodSync(ok, 0o700);
  writeFileSync(bad, "#!/bin/sh\necho 'broken install' >&2\nexit 3\n"); chmodSync(bad, 0o700);
  try {
    await preflight(requiredTools(ok, ok, []));
    const err = await preflight(requiredTools(ok, bad, [])).catch((e: Error) => e.message);
    expect(err).toContain("ocs is installed but");
    expect(err).toContain("broken install");
    expect(err).not.toContain("tmux");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a bare worker wrapper call says to run task, not the driver help", () => {
  const env = { ...process.env, SFLOW_TOKEN: "t", SFLOW_STEP_ID: "join", SFLOW_NO_UPDATE_CHECK: "1" };
  const out = Bun.spawnSync(["bun", "src/cli.ts"], { env, cwd: import.meta.dir + "/.." }).stdout.toString();
  expect(out).toContain('step join. Run it with "task"');
  expect(out).not.toContain("sflow init");
});
