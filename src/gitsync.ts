import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { checked } from "./process";

// Moving code to another host without touching the user's repository: new objects go to a
// private object directory, and the project's own objects are borrowed as alternates.
export interface Frozen { root: string; head: string; commit: string; tree: string; repo: string }

async function git(cwd: string, args: string[], env: Record<string, string> = {}, timeoutMs = 120_000) {
  return (await checked(["git", "-C", cwd, ...args], { env: { ...process.env, ...env }, timeoutMs })).trim();
}
export async function objectsDir(cwd: string): Promise<string> {
  const common = await git(cwd, ["rev-parse", "--git-common-dir"]);
  return realpathSync(join(isAbsolute(common) ? common : resolve(cwd, common), "objects"));
}
export async function privateEnv(cwd: string, priv: string): Promise<Record<string, string>> {
  mkdirSync(priv, { recursive: true, mode: 0o700 });
  return { GIT_OBJECT_DIRECTORY: priv, GIT_ALTERNATE_OBJECT_DIRECTORIES: await objectsDir(cwd) };
}
// One id per project on every host: its first root commit, so clones of the same repository share it.
export async function repoId(cwd: string): Promise<string> {
  const roots = (await git(cwd, ["rev-list", "--max-parents=0", "HEAD"])).split("\n").filter(Boolean).sort();
  return createHash("sha256").update(roots[0] ?? realpathSync(cwd)).digest("hex").slice(0, 16);
}
// Tracked plus untracked, non-ignored files, as a commit whose parent is HEAD. The user's index
// is never written: a temporary index lives next to the private objects.
export async function freeze(cwd: string, priv: string, env: Record<string, string> = {}): Promise<Frozen> {
  const root = realpathSync(await git(cwd, ["rev-parse", "--show-toplevel"]));
  const head = await git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const stage = await git(root, ["ls-files", "--stage"]);
  if (stage.split("\n").some(l => l.startsWith("160000 "))) throw new Error(`${root}: submodules are not sent to other hosts`);
  const vars = { ...env, ...(priv ? await privateEnv(root, priv) : {}) };
  const index = join(priv || (env.TMPDIR ?? tmpdir()), `sflow-index-${randomUUID()}`);
  try {
    const e = { ...vars, GIT_INDEX_FILE: index };
    await git(root, ["read-tree", head], e);
    await git(root, ["add", "-A", "--", "."], e, 600_000);
    const tree = await git(root, ["write-tree"], e);
    const commit = await git(root, ["commit-tree", tree, "-p", head, "-m", "sflow snapshot"],
      { ...e, GIT_AUTHOR_NAME: "sflow", GIT_AUTHOR_EMAIL: "sflow@localhost", GIT_COMMITTER_NAME: "sflow", GIT_COMMITTER_EMAIL: "sflow@localhost",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" });
    return { root, head, commit, tree, repo: await repoId(root) };
  } finally { rmSync(index, { force: true }); rmSync(`${index}.lock`, { force: true }); }
}
// Sends one commit (and whatever history the host lacks) to the host's bare repository.
export async function push(root: string, priv: string, url: string, commit: string, ref: string, env: Record<string, string>) {
  const vars = { ...(priv ? await privateEnv(root, priv) : {}), ...env };
  await git(root, ["push", "--quiet", "--no-verify", url, `${commit}:${ref}`], vars, 30 * 60_000);
}
export function bareRepo(home: string, repo: string): string {
  if (!/^[0-9a-f]{16}$/.test(repo)) throw new Error("invalid repo id");
  return join(home, "repos", `${repo}.git`);
}
export async function ensureBare(path: string) {
  if (!existsSync(join(path, "HEAD"))) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    await checked(["git", "init", "--quiet", "--bare", path]);
  }
}
export async function verifyCommit(bare: string, commit: string, tree: string) {
  if (!/^[0-9a-f]{40,64}$/.test(commit) || !/^[0-9a-f]{40,64}$/.test(tree)) throw new Error("invalid commit or tree id");
  const got = await git(bare, ["rev-parse", "--verify", `${commit}^{tree}`]);
  if (got !== tree) throw new Error(`received commit ${commit} has tree ${got}, expected ${tree}`);
}
