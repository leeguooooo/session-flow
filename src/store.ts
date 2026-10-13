import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, unlinkSync, fsyncSync, existsSync, lstatSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, basename, dirname } from "node:path";
import type { Run, Workflow } from "./types";

export function dataHome(): string { return resolve(process.env.SFLOW_HOME ?? join(homedir(), ".local/state/session-flow")); }
export function atomicWrite(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
export function createRun(workflow: Workflow): Run {
  const id = randomUUID();
  const dir = join(dataHome(), "runs", id);
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  // Unix socket path length is limited to ~104 bytes on macOS. Place it in a
  // private, short directory; never share the user's default tmux server.
  const socketDir = join(process.env.TMPDIR ?? "/tmp", `sf-${id.slice(0, 12)}`);
  mkdirSync(socketDir, { mode: 0o700 });
  const run: Run = { version: 1, id, dir, socket: join(socketDir, "tmux.sock"), channel: `sflow-${id}`,
    workflow, createdAt: Date.now(), status: "running", steps: Object.fromEntries(workflow.steps.map(s => [s.id,
      { status: "pending", token: randomBytes(24).toString("hex"), session: `sf-${s.id}` }])) };
  saveRun(run); return run;
}
export function saveRun(run: Run) { atomicWrite(join(run.dir, "run.json"), run); }
export function loadRun(id: string): Run {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("invalid run id");
  const dir = join(dataHome(), "runs", id);
  const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as Run;
  if (run.version !== 1 || run.id !== id || run.dir !== dir) throw new Error("invalid run record");
  if (basename(run.socket) !== "tmux.sock" || basename(dirname(run.socket)) !== `sf-${id.slice(0, 12)}`) throw new Error("invalid owned runtime socket path");
  if (existsSync(dirname(run.socket))) {
    const owner = lstatSync(dirname(run.socket));
    if (!owner.isDirectory() || owner.isSymbolicLink() || (owner.mode & 0o077) !== 0 || (process.getuid && owner.uid !== process.getuid())) throw new Error("runtime socket directory is not private and owned");
  }
  return run;
}
export function lockRun(run: Run): () => void {
  const path = join(run.dir, "driver.lock");
  try {
    const fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, String(process.pid)); closeSync(fd);
  } catch {
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("invalid driver lock; inspect before recovering");
    try { process.kill(pid, 0); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        // Claim the stale lock atomically; only one recovery process wins.
        const claim = `${path}.stale`;
        if (existsSync(claim)) throw new Error("driver lock recovery already in progress");
        try { mkdirSync(claim, { mode: 0o700 }); } catch { throw new Error("driver lock recovery already in progress"); }
        try { unlinkSync(path); } finally { /* retained tombstone prevents competing takeover */ }
        const release = lockRun(run);
        return () => { release(); requireRemoveDir(claim); };
      }
      throw err;
    }
    throw new Error(`run already driven by pid ${pid}`);
  }
  return () => { if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path); };
}
import { rmdirSync } from "node:fs";
function requireRemoveDir(path: string) { rmdirSync(path); }
