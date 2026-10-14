// use-family upgrade convention (leeguooooo/plugins docs/upgrade.md): `sflow upgrade`,
// a daily "new version" notice on stderr, and refreshing every copy of the skill.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { skillPaths } from "./skill";

export const REPO = "leeguooooo/session-flow";
export const PLUGIN_ID = "sflow@leeguooooo-plugins";
export const UPDATE_CHECK_COMMAND = "_update-check";
const INSTALL_URL = `https://raw.githubusercontent.com/${REPO}/main/install.sh`;
const DAY_MS = 24 * 60 * 60 * 1000;

type Version = [number, number, number];
export function parseVersion(raw: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function newer(latest: string, current: string): boolean {
  const a = parseVersion(latest), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// Any failure (offline, rate limit, odd payload) is an error value, never a throw.
export async function fetchLatest(env: NodeJS.ProcessEnv = process.env, timeoutMs = 3000): Promise<{ version: string } | { error: string }> {
  const url = env.SFLOW_UPGRADE_LATEST_URL || `https://api.github.com/repos/${REPO}/releases/latest`;
  const headers: Record<string, string> = { "user-agent": "sflow-upgrade", accept: "application/vnd.github+json" };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const tag = ((await response.json()) as { tag_name?: unknown }).tag_name;
    if (typeof tag !== "string" || !parseVersion(tag)) return { error: `unexpected release tag ${JSON.stringify(tag)}` };
    return { version: tag.replace(/^v/, "") };
  } catch (e) {
    const err = e as Error;
    return { error: err.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : err.message };
  }
}

export interface SkillCopy { channel: "claude-plugin" | "git-checkout" | "copied" | "installer"; path: string; update: string }

function gitRoot(dir: string): string | null {
  const out = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return out.status === 0 && out.stdout.trim() ? out.stdout.trim() : null;
}

export function detectSkills(env: NodeJS.ProcessEnv = process.env, home = homedir()): SkillCopy[] {
  const found: SkillCopy[] = [];
  const plugins = join(home, ".claude", "plugins", "installed_plugins.json");
  try { if (readFileSync(plugins, "utf8").includes(`"${PLUGIN_ID}`)) found.push({ channel: "claude-plugin", path: plugins, update: `claude plugin update ${PLUGIN_ID}` }); } catch {}
  const managed = new Set(skillPaths(env, home).map(dirname));
  for (const dir of [join(home, ".agents", "skills", "sflow"), ...managed]) {
    if (!existsSync(join(dir, "SKILL.md"))) continue;
    let real: string;
    try { real = realpathSync(dir); } catch { continue; }
    const root = gitRoot(real);
    if (root) found.push({ channel: "git-checkout", path: dir, update: `git -C ${root} pull --ff-only` });
    else if (managed.has(dir)) found.push({ channel: "installer", path: dir, update: "sflow skill install" });
    else found.push({ channel: "copied", path: dir, update: "npx skills update sflow" });
  }
  return found;
}

// The installer has already rewritten its own copies; refresh or name the rest.
export function refreshSkills(copies: SkillCopy[]): string[] {
  return copies.map(copy => {
    if (copy.channel === "claude-plugin") {
      const out = spawnSync("claude", ["plugin", "update", PLUGIN_ID], { encoding: "utf8" });
      return !out.error && out.status === 0 ? "skill (claude-plugin): updated; restart Claude Code or /reload-plugins" : `skill (claude-plugin): run \`${copy.update}\``;
    }
    if (copy.channel === "git-checkout") {
      const out = spawnSync("git", ["-C", copy.update.split(" ")[2], "pull", "-q", "--ff-only"], { encoding: "utf8" });
      return out.status === 0 ? `skill (git-checkout ${copy.path}): updated` : `skill (git-checkout ${copy.path}): not updated (${out.stderr?.trim() || "local changes?"})`;
    }
    if (copy.channel === "copied") return `skill (copied ${copy.path}): run \`${copy.update}\``;
    return `skill (${copy.path}): refreshed by the installer`;
  });
}

export async function upgrade(current: string, mode: "install" | "check" | "json", env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const latest = await fetchLatest(env);
  const skills = detectSkills(env, env.HOME || homedir());
  if (mode === "json") {
    console.log(JSON.stringify({ name: "sflow", current, latest: "version" in latest ? latest.version : null,
      update_available: "version" in latest && newer(latest.version, current), skills, ...("error" in latest ? { error: latest.error } : {}) }, null, 2));
    return "error" in latest ? 2 : 0;
  }
  if ("error" in latest) { console.error(`sflow: could not check the latest release: ${latest.error}`); return 2; }
  if (!newer(latest.version, current)) { console.log(`sflow ${current} is up to date`); return 0; }
  if (mode === "check") { console.log(`sflow ${current} -> ${latest.version}`); return 0; }
  const argv = env.SFLOW_UPGRADE_INSTALLER ? ["sh", env.SFLOW_UPGRADE_INSTALLER] : ["sh", "-c", `curl -fsSL ${INSTALL_URL} | sh`];
  const run = spawnSync(argv[0], argv.slice(1), { stdio: "inherit", env });
  if (run.status !== 0) { console.error(`sflow: installer failed (${argv.join(" ")})`); return 2; }
  for (const line of refreshSkills(skills)) console.log(line);
  console.log(`sflow ${current} -> ${latest.version}`);
  return 0;
}

function cachePath(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "sflow", "update-check.json");
}
function readCache(env: NodeJS.ProcessEnv): { checked_at: number; latest: string | null } | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(env), "utf8"));
    return typeof raw.checked_at === "number" ? { checked_at: raw.checked_at, latest: typeof raw.latest === "string" ? raw.latest : null } : null;
  } catch { return null; }
}
function writeCache(env: NodeJS.ProcessEnv, now: number, latest: string | null) {
  mkdirSync(dirname(cachePath(env)), { recursive: true });
  writeFileSync(cachePath(env), `${JSON.stringify({ checked_at: Math.floor(now / 1000), latest })}\n`);
}

// Workers run `task`/`report` inside their own turns; keep their output to the protocol.
const QUIET = ["upgrade", "version", "--version", "help", "--help", "task", "report"];
export function noticeDisabled(env: NodeJS.ProcessEnv, cmd: string | undefined): boolean {
  return Boolean(env.CI || env.SFLOW_NO_UPDATE_CHECK || env.USE_NO_UPDATE_CHECK) || !cmd || cmd.startsWith("_") || QUIET.includes(cmd);
}

// Prints from the cache only; a stale cache sends a detached check, so no command waits on the network.
export function maybeNotice(current: string, cmd: string | undefined, self: string[], env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  if (noticeDisabled(env, cmd)) return;
  const cache = readCache(env);
  if (cache?.latest && newer(cache.latest, current)) process.stderr.write(`sflow ${cache.latest} is available (you have ${current}). Upgrade: sflow upgrade\n`);
  if (cache && now - cache.checked_at * 1000 < DAY_MS) return;
  try {
    // Claim the slot first so concurrent calls start one check, not many.
    writeCache(env, now, cache?.latest ?? null);
    spawn(self[0], [...self.slice(1), UPDATE_CHECK_COMMAND], { detached: true, stdio: "ignore", env }).unref();
  } catch {}
}

// Success or failure both record checked_at, so an offline machine is not retried on every call.
export async function runUpdateCheck(env: NodeJS.ProcessEnv = process.env) {
  const latest = await fetchLatest(env, 2000);
  writeCache(env, Date.now(), "version" in latest ? latest.version : readCache(env)?.latest ?? null);
}
