import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real-tmux tests need a tmux that can start a server here; CI runners and agent sandboxes may
// not allow one, so elsewhere they are skipped. CI's integration phase sets SFLOW_TEST_REQUIRE_TMUX=1 so
// they can never be skipped silently there; every other test must not touch tmux at all.
export const tmuxWorks = (() => {
  if (!Bun.which("tmux")) return false;
  const sock = join(tmpdir(), `sf-probe-${process.pid}.sock`);
  const ok = spawnSync("tmux", ["-S", sock, "new-session", "-d", "-s", "p", "sleep", "1"]).status === 0;
  spawnSync("tmux", ["-S", sock, "kill-server"]); rmSync(sock, { force: true });
  return ok;
})();
if (process.env.SFLOW_TEST_REQUIRE_TMUX === "1" && !tmuxWorks) throw new Error("SFLOW_TEST_REQUIRE_TMUX=1, but tmux cannot start a server here");

// A shared marker lets CI select every real-tmux case without duplicating unit tests.
export function tmuxTest(name: string, body: () => Promise<void>, timeout?: number) {
  return test.skipIf(!tmuxWorks)(`[tmux] ${name}`, body, timeout);
}
