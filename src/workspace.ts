import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, mkdirSync, writeFileSync, renameSync, realpathSync } from "node:fs";
import { join, dirname, relative, isAbsolute } from "node:path";
import { checked, command } from "./process";
import { workspaceRoot } from "./config";
import type { Run, Step } from "./types";

interface Entry { hash: string; mode: number; kind: "file" | "symlink" }
export interface Snapshot { root: string; head: string; index: string; files: Record<string, Entry> }
export function observedProject(run: Run, step: Step): string | undefined {
  // Command steps and steps on other hosts read a frozen copy; they cannot write this checkout.
  if (step.agent === "command" || step.host) return undefined;
  const owner = run.workflow.steps.find(s => s.id === workspaceRoot(run.workflow.steps, step))!;
  if (owner.inPlace) return owner.cwd;
  if (step.policy === "workspace-write") return undefined;
  // Review the same checkout, including a nested directory.
  return run.workflow.steps.find(s => s.inPlace && (() => {
    const a = realpathSync(s.cwd), b = realpathSync(step.cwd);
    return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
  })())?.cwd;
}
export async function snapshot(cwd: string, destination: string): Promise<Snapshot> {
  const root = realpathSync((await checked(["git", "-C", cwd, "rev-parse", "--show-toplevel"])).trim());
  // Read-only observation; never write an index, stash or commit.
  const head = (await checked(["git", "-C", root, "rev-parse", "HEAD"])).trim();
  const index = await checked(["git", "-C", root, "ls-files", "--stage", "-z"]);
  if (index.split("\0").some(s => s.startsWith("160000 "))) throw new Error("in-place snapshots do not support submodules");
  const names = (await checked(["git", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  const temp = destination + "." + randomUUID(); mkdirSync(join(temp, "files"), { recursive: true, mode: 0o700 });
  const files: Record<string, Entry> = Object.create(null);
  for (const name of new Set(names)) {
    if (isAbsolute(name) || name.split("/").includes("..")) throw new Error("unsafe git path");
    const path = join(root, name);
    // Do not follow a parent symlink outside the checkout.
    let stat; try { stat = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    const parent = relative(root, realpathSync(dirname(path)));
    if (parent.startsWith("../") || isAbsolute(parent)) throw new Error("git path escapes checkout through symlink");
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`unsupported in-place file: ${name}`);
    const data = stat.isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path);
    files[name] = { hash: createHash("sha256").update(data).digest("hex"), mode: stat.mode & 0o777, kind: stat.isSymbolicLink() ? "symlink" : "file" };
    const out = join(temp, "files", name); mkdirSync(dirname(out), { recursive: true, mode: 0o700 }); writeFileSync(out, data, { mode: 0o600 });
  }
  // Refuse a racing index/HEAD snapshot. Content races remain an explicit observation limitation.
  if (head !== (await checked(["git", "-C", root, "rev-parse", "HEAD"])).trim() || index !== await checked(["git", "-C", root, "ls-files", "--stage", "-z"])) throw new Error("checkout changed while taking snapshot");
  const result = { root, head, index, files };
  writeFileSync(join(temp, "snapshot.json"), JSON.stringify(result), { mode: 0o600 }); renameSync(temp, destination);
  return result;
}
export function readSnapshot(path: string): Snapshot { return JSON.parse(readFileSync(join(path, "snapshot.json"), "utf8")); }
export function changedFiles(a: Snapshot, b: Snapshot): string[] {
  return [...new Set([...Object.keys(a.files), ...Object.keys(b.files)])].sort().filter(p => JSON.stringify(a.files[p]) !== JSON.stringify(b.files[p]));
}
export function sameSnapshot(a: Snapshot, b: Snapshot): boolean { return a.root === b.root && a.head === b.head && a.index === b.index && !changedFiles(a, b).length; }
export async function beginObservation(run: Run, step: Step) {
  const cwd = observedProject(run, step), state = run.steps[step.id];
  if (!cwd || state.baseline) return;
  const path = join(run.dir, `${step.id}-before`), before = await snapshot(cwd, path);
  state.baseline = path;
  const previous = run.workflow.steps.filter(s => run.steps[s.id].observedEnd).map(s => run.steps[s.id])
    .filter(s => readSnapshot(s.observedEnd!).root === before.root).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
  if (previous && !sameSnapshot(readSnapshot(previous.observedEnd!), before)) throw new Error("checkout changed outside the workflow between steps; inspect snapshots and start a new run");
}
export async function endObservation(run: Run, step: Step) {
  const state = run.steps[step.id];
  if (!state.baseline || state.observedEnd || !state.result) return;
  const before = readSnapshot(state.baseline), path = join(run.dir, `${step.id}-after`);
  const after = await snapshot(before.root, path); state.observedEnd = path;
  state.workspaceWarning = "Observed delta since this step started; concurrent outside writes during a write step cannot be attributed. Ignored files are not observed.";
  if (before.head !== after.head || before.index !== after.index || (step.policy === "read-only" && !sameSnapshot(before, after))) {
    state.status = "blocked"; state.error = "checkout HEAD/index changed, or files changed during read-only review; inspect snapshots before continuing";
  }
}
export async function snapshotDiff(before: string, after: string, output: string): Promise<string> {
  const r = await command(["git", "diff", "--no-index", "--no-ext-diff", "--", join(before, "files"), join(after, "files")]);
  if (r.code > 1) throw new Error(`snapshot diff failed: ${r.stderr}`);
  writeFileSync(output, r.stdout, { mode: 0o600 }); return output;
}
