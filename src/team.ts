// Teams: long-lived native sessions with roles, coordinated by conversation instead of a
// workflow. sflow starts, records, shows and stops them; OCS carries identity and messages.
// There is no completion guarantee here: whether work is done is the lead's judgement.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ID, physical } from "./config";
import { atomicWrite, dataHome, lockDir } from "./store";
import { checked, cleanEnv, command, quote } from "./process";
import { allowWorker, claudeSettings, nativeArgv } from "./runtime";
import { nativeActor } from "./protocol";
import { parseMenu, type Menu } from "./prompt";
import type { Agent, Message, Policy, Transport } from "./types";

export type TeamAgent = "claude" | "codex" | "pi";
export const TEAM_AGENTS: readonly TeamAgent[] = ["claude", "codex", "pi"];
export type MemberStatus = "launching" | "ready" | "closed" | "uncertain";
export interface Member {
  role: string;
  agent: TeamAgent;
  model?: string;
  cwd: string;
  policy: Policy;
  instructions?: string;
  // Where the instructions came from: "flag" or the file they were read from.
  instructionsSource?: string;
  token: string;
  session: string;
  status: MemberStatus;
  actor?: string;
  // What the member's ready command could check about the pane it runs in.
  pane?: { verified: boolean; paneId?: string; reason?: string };
  // Written before tmux is asked to start anything; a start is attempted once.
  launch: { attemptedAt: number; startedAt?: number };
  readyAt?: number;
  closedAt?: number;
  error?: string;
}
export interface Team {
  kind: "sflow-team";
  schemaVersion: 1;
  id: string;
  dir: string;
  socket: string;
  channel: string;
  createdAt: number;
  members: Record<string, Member>;
}
export interface ReadyEvent {
  type: "sflow.team";
  version: 1;
  teamId: string;
  role: string;
  actor: string;
  status: "ready";
  pane: { verified: boolean; paneId?: string; reason?: string };
  proof: string;
}

// ---- records ----

export const teamsHome = () => join(dataHome(), "teams");
const sender = (team: Team) => `sflow-team-${team.id}`;
export function teamDir(id: string) {
  if (!ID.test(id)) throw new Error(`team name must match ${ID} (lowercase letters, digits and dashes)`);
  return join(teamsHome(), id);
}
export function saveTeam(team: Team) { atomicWrite(join(team.dir, "team.json"), team); }
export function loadTeam(id: string): Team {
  const dir = teamDir(id), file = join(dir, "team.json");
  if (!existsSync(file)) throw new Error(`no team ${id}; start one with sflow team spawn <role> --team ${id} …`);
  const team = JSON.parse(readFileSync(file, "utf8")) as Team;
  if (team.kind !== "sflow-team") throw new Error(`${file} is not a team record`);
  if (team.schemaVersion !== 1) throw new Error(`team ${id} was written by a newer sflow (schema ${team.schemaVersion}); upgrade sflow`);
  if (team.id !== id || team.dir !== dir) throw new Error("invalid team record");
  if (basename(team.socket) !== "tmux.sock" || !/^sf-t-[0-9a-f]{12}$/.test(basename(dirname(team.socket)))) throw new Error("invalid team socket path");
  if (existsSync(dirname(team.socket))) {
    const owner = lstatSync(dirname(team.socket));
    if (!owner.isDirectory() || owner.isSymbolicLink() || (owner.mode & 0o077) !== 0 || (process.getuid && owner.uid !== process.getuid())) throw new Error("team socket directory is not private and owned");
  }
  return team;
}
export function listTeams(): string[] {
  if (!existsSync(teamsHome())) return [];
  return readdirSync(teamsHome()).filter(id => ID.test(id) && existsSync(join(teamsHome(), id, "team.json"))).sort();
}
function openTeam(id: string): Team {
  const dir = teamDir(id);
  if (existsSync(join(dir, "team.json"))) return loadTeam(id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Unix socket paths are limited to ~104 bytes on macOS: a short private directory, never the
  // user's default tmux server.
  const socketDir = join(process.env.TMPDIR ?? "/tmp", `sf-t-${randomBytes(6).toString("hex")}`);
  mkdirSync(socketDir, { mode: 0o700 });
  const team: Team = { kind: "sflow-team", schemaVersion: 1, id, dir, socket: join(socketDir, "tmux.sock"),
    channel: `sflow-team-${id}`, createdAt: Date.now(), members: {} };
  saveTeam(team); return team;
}
// Record changes are short critical sections; waiting for a member never holds the lock.
export async function withTeam<T>(id: string, fn: (team: Team) => Promise<T> | T, create = false): Promise<T> {
  const dir = teamDir(id);
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  else if (!existsSync(dir)) loadTeam(id);
  let release: (() => void) | undefined;
  for (let i = 0; !release; i++) {
    try { release = lockDir(dir, "team.lock"); }
    catch (e) { if (i >= 100 || !String((e as Error).message).startsWith("run already driven")) throw e; await Bun.sleep(50); }
  }
  try { return await fn(create ? openTeam(id) : loadTeam(id)); } finally { release(); }
}

// ---- proof ----

function canonical(e: Omit<ReadyEvent, "proof">) {
  return JSON.stringify({ type: e.type, version: e.version, teamId: e.teamId, role: e.role, actor: e.actor, status: e.status,
    pane: { verified: e.pane.verified, ...(e.pane.paneId ? { paneId: e.pane.paneId } : {}), ...(e.pane.reason ? { reason: e.pane.reason } : {}) } });
}
export function readyProof(e: Omit<ReadyEvent, "proof">, token: string) { return createHmac("sha256", token).update(canonical(e)).digest("hex"); }
function validReady(e: ReadyEvent, token: string) {
  if (typeof e.proof !== "string" || !/^[0-9a-f]{64}$/.test(e.proof)) return false;
  return timingSafeEqual(Buffer.from(e.proof, "hex"), Buffer.from(readyProof(e, token), "hex"));
}

// ---- tmux ----

export class TeamTmux {
  constructor(readonly binary = process.env.SFLOW_TMUX_BIN ?? "tmux") {}
  async exists(team: Team, m: Member) {
    const r = await command([this.binary, "-S", team.socket, "has-session", "-t", `=${m.session}`]);
    if (r.code === 0) return true;
    if (r.code === 1 && /no server running|no sessions|can't find session|error connecting|No such file/.test(r.stderr)) return false;
    throw new Error(`cannot inspect tmux session: ${r.stderr}`);
  }
  async start(team: Team, m: Member, cwd: string, script: string, env: NodeJS.ProcessEnv) {
    const workerEnv = ["OCS_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"].flatMap(k => env[k] === undefined ? [] : ["-e", `${k}=${env[k]}`]);
    await checked([this.binary, "-S", team.socket, "new-session", "-d", "-s", m.session, ...workerEnv, "-x", "140", "-y", "45", "-c", cwd, "/bin/sh", script], { env });
  }
  async screen(team: Team, m: Member, lines = 0) {
    return await checked([this.binary, "-S", team.socket, "capture-pane", "-p", "-t", `${m.session}:0.0`, ...(lines ? ["-S", `-${lines}`] : [])]);
  }
  // One paste and one Enter, never repeated: a TUI that is mid-turn queues the text itself.
  async paste(team: Team, m: Member, file: string) {
    const buffer = `sft-${m.role}`;
    await checked([this.binary, "-S", team.socket, "load-buffer", "-b", buffer, file]);
    try {
      await checked([this.binary, "-S", team.socket, "paste-buffer", "-p", "-d", "-b", buffer, "-t", `${m.session}:0.0`]);
      await Bun.sleep(120);
      await checked([this.binary, "-S", team.socket, "send-keys", "-t", `${m.session}:0.0`, "Enter"]);
    } catch (e) { throw Object.assign(new Error(`delivery uncertain: ${(e as Error).message}`), { uncertain: true }); }
  }
  async kill(team: Team, m: Member) { await checked([this.binary, "-S", team.socket, "kill-session", "-t", `=${m.session}`]); }
  async killServer(team: Team) { await command([this.binary, "-S", team.socket, "kill-server"]); }
  attachArgs(team: Team, m: Member) { return [this.binary, "-S", team.socket, "attach-session", "-t", `=${m.session}`]; }
}

// ---- spawn ----

export interface SpawnOptions {
  team: string; role: string; agent: string; model?: string; cwd: string; write?: boolean;
  instructions?: string; instructionsSource?: string; cli: string[];
}
function checkProject(cwd: string) {
  const project = realpathSync(cwd);
  for (const path of [process.env.SFLOW_HOME ?? resolve(homedir(), ".local/state/session-flow"), process.env.OCS_HOME ?? resolve(homedir(), ".ocs")]) {
    const root = physical(path);
    if (project === root || project.startsWith(root + "/") || root.startsWith(project + "/")) throw new Error("cwd overlaps sflow's or OCS's own state directory");
  }
  return project;
}
export function validateSpawn(o: SpawnOptions): { agent: TeamAgent; cwd: string } {
  if (!ID.test(o.role)) throw new Error(`role must match ${ID} (lowercase letters, digits and dashes)`);
  if (o.agent === "agy") throw new Error("agy has no per-session identity in OCS, so a team cannot tell two agy members apart; use claude, codex or pi");
  if (!TEAM_AGENTS.includes(o.agent as TeamAgent)) throw new Error(`agent must be one of ${TEAM_AGENTS.join(", ")}`);
  if (o.model !== undefined && (!o.model.trim() || o.model.startsWith("-"))) throw new Error("invalid model");
  if (o.instructions !== undefined && Buffer.byteLength(o.instructions) > 32 * 1024) throw new Error("instructions are limited to 32 KiB");
  const cwd = resolve(o.cwd);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
  const project = checkProject(cwd);
  if (o.write) {
    // Edits land in the checkout itself, so they must show up in git diff for review.
    const git = Bun.spawnSync(["git", "-C", project, "rev-parse", "--show-toplevel"]);
    if (git.exitCode !== 0) throw new Error("--write edits cwd in place, so cwd must be inside a Git checkout");
  }
  return { agent: o.agent as TeamAgent, cwd: project };
}

export function memberPrompt(team: Team, m: Member, wrapper: string): string {
  const w = quote(wrapper);
  const policy = m.policy === "workspace-write"
    ? `You may edit files in ${m.cwd} directly (no worktree): leave changes uncommitted for review.`
    : `Read-only: inspect ${m.cwd} but do not edit files.`;
  return `Session Flow team member "${m.role}" in team "${team.id}".
First run ${w} ready once. It records you as this member and prints your OCS address and your teammates'. If it fails, stop and say why.
Then wait for messages. They arrive in this session (pasted by sflow team send, or as OCS wakes). Do what a message asks, then answer its sender with the Reply line it carries. Do not start work on your own, do not poll other agents, and keep OCS traffic to replies. ${w} ls shows the team.
Project: ${m.cwd}. ${policy}
Do not commit, push, merge, change global settings or bypass approvals. Preserve pre-existing edits; never reset, stash, clean or overwrite unrelated changes. No secrets in messages.${m.instructions ? `\n\nRole instructions (${m.instructionsSource ?? "flag"}):\n${m.instructions}` : ""}`;
}

export async function spawnMember(o: SpawnOptions, tmux = new TeamTmux()): Promise<{ team: Team; member: Member }> {
  const { agent, cwd } = validateSpawn(o);
  return withTeam(o.team, async team => {
    const old = team.members[o.role];
    if (old && old.status !== "closed") throw new Error(old.status === "uncertain"
      ? `member ${o.role} is uncertain (${old.error ?? "state unknown"}); inspect it with sflow team logs/attach, then sflow team stop ${o.role}`
      : `member ${o.role} already exists (${old.status}); stop it first or pick another role`);
    const m: Member = { role: o.role, agent, ...(o.model ? { model: o.model } : {}), cwd, policy: o.write ? "workspace-write" : "read-only",
      ...(o.instructions ? { instructions: o.instructions, instructionsSource: o.instructionsSource ?? "flag" } : {}),
      token: randomBytes(24).toString("hex"), session: `sft-${o.role}`, status: "launching", launch: { attemptedAt: Date.now() } };
    const dir = join(team.dir, o.role);
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const protocol = join(team.dir, ".protocol"); mkdirSync(protocol, { recursive: true, mode: 0o700 });
    const tmp = join(tmpdir(), `sflow-team-${team.id}-${o.role}`); mkdirSync(tmp, { recursive: true, mode: 0o700 });
    // Codex filters inherited variables named like *TOKEN*, so the member's context travels in
    // this wrapper, which it runs by path.
    const wrapper = join(dir, "member");
    const contextEnv: Record<string, string> = { SFLOW_HOME: dataHome(), SFLOW_TEAM_ID: team.id, SFLOW_ROLE: o.role, SFLOW_TOKEN: m.token,
      SFLOW_OCS_BIN: process.env.SFLOW_OCS_BIN ?? "ocs", ...(process.env.SFLOW_TMUX_BIN ? { SFLOW_TMUX_BIN: process.env.SFLOW_TMUX_BIN } : {}),
      ...(process.env.OCS_HOME ? { OCS_HOME: process.env.OCS_HOME } : {}) };
    writeFileSync(wrapper, `#!/bin/sh\n${Object.entries(contextEnv).map(([k, v]) => `export ${k}=${quote(v)}`).join("\n")}\nexec ${[...o.cli, "team"].map(quote).join(" ")} "$@"\n`, { mode: 0o700 });
    const prompt = memberPrompt(team, m, wrapper);
    writeFileSync(join(dir, "bootstrap.txt"), prompt, { mode: 0o600 });
    const ocsHome = process.env.OCS_HOME ?? join(homedir(), ".ocs");
    const readOnly = m.policy === "read-only";
    // A read-only Codex member starts in the team's protocol directory, so its sandbox can write
    // there and to OCS but not to the project, which it still reads by absolute path.
    const start = agent === "codex" && readOnly ? protocol : cwd;
    const argv = agent === "claude"
      ? nativeArgv("claude", { model: m.model, prompt, readOnly, dirs: [dir], claude: { settings: claudeSettings(protocol), name: `sflow-${team.id}-${o.role}`,
          allowedTools: [allowWorker(wrapper, quote(wrapper), ["ready", "ls"]), "Bash(ocs dm *)", "Bash(ocs read *)", "Bash(ocs whoami*)"].join(",") } })
      : agent === "codex"
        ? nativeArgv("codex", { model: m.model, prompt, readOnly, dirs: [...(readOnly ? [protocol] : []), dir, tmp, ocsHome] })
        : nativeArgv("pi", { model: m.model, prompt, readOnly, dirs: [] });
    const script = join(dir, "start.sh");
    writeFileSync(script, `#!/bin/sh\nexport TMPDIR=${quote(tmp)}\nexec ${argv.map(quote).join(" ")}\n`, { mode: 0o700 });
    const env = cleanEnv();
    for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "OCS_HOME"]) if (process.env[key]) env[key] = process.env[key];
    // The intent is durable before tmux is asked; a crash after this point is reconciled, not retried.
    team.members[o.role] = m; saveTeam(team);
    try { await tmux.start(team, m, start, script, env); m.launch.startedAt = Date.now(); }
    catch (e) {
      let running: boolean | undefined;
      try { running = await tmux.exists(team, m); } catch {}
      if (running === false) { m.status = "closed"; m.closedAt = Date.now(); m.error = `launch failed: ${(e as Error).message}`; }
      else if (running === undefined) { m.status = "uncertain"; m.error = `launch outcome unknown: ${(e as Error).message}`; }
      else m.launch.startedAt = Date.now();
    }
    saveTeam(team);
    if (m.status === "closed") throw new Error(m.error);
    return { team, member: m };
  }, true);
}

// ---- member side: ready ----

export interface PaneCheck { verified: boolean; paneId?: string; reason?: string; refuse?: string }
// Evidence that this command runs inside the member's own pane. A definite mismatch refuses;
// a check that cannot run (a sandbox blocking the tmux socket) is recorded as unverified. This
// prevents misattribution between sessions of one user; it is not authentication.
export async function checkPane(team: Team, m: Member, env = process.env, binary = process.env.SFLOW_TMUX_BIN ?? "tmux"): Promise<PaneCheck> {
  const tmuxVar = env.TMUX, pane = env.TMUX_PANE;
  if (!tmuxVar || !pane) return { verified: false, reason: "TMUX/TMUX_PANE not visible to this command" };
  let mine: string, ours: string;
  // realpath cannot open a socket file itself, so its directory is resolved instead.
  const physicalSocket = (p: string) => join(realpathSync(dirname(p)), basename(p));
  try { mine = physicalSocket(tmuxVar.split(",")[0]); ours = physicalSocket(team.socket); }
  catch (e) { return { verified: false, reason: `cannot resolve the tmux socket: ${(e as Error).message}` }; }
  if (mine !== ours) return { verified: false, refuse: "this command runs in another tmux server, not in the member's session" };
  let r: Awaited<ReturnType<typeof command>>;
  try { r = await command([binary, "-S", team.socket, "display-message", "-p", "-t", pane, "#{session_name}\t#{pane_id}\t#{pane_dead}"], { timeoutMs: 5000 }); }
  catch (e) { return { verified: false, reason: `cannot query tmux: ${(e as Error).message}` }; }
  if (r.code) return { verified: false, reason: `cannot query tmux: ${(r.stderr || r.stdout).trim().split("\n")[0]}` };
  const [session, paneId, dead] = r.stdout.trim().split("\t");
  if (session !== m.session) return { verified: false, refuse: `this pane belongs to tmux session ${session}, not ${m.session}` };
  if (dead === "1") return { verified: false, refuse: "this pane is dead" };
  return { verified: true, paneId };
}

export function roster(team: Team): string[] {
  return Object.values(team.members).filter(m => m.status !== "closed").map(m => `  ${m.role} (${m.agent}, ${m.status}): ${address(team, m)}`);
}
// How to reach a member. Claude and Pi sessions wake on `ocs dm`; Codex CLI sessions do not
// (OCS wakes only Codex tasks open in the desktop app), so they are reached by a paste.
export function address(team: Team, m: Member): string {
  if (m.status !== "ready" || !m.actor) return `not ready; sflow team send ${team.id} ${m.role} "…" once it is`;
  return m.agent === "codex" ? `sflow team send ${team.id} ${m.role} "…" (OCS id ${m.actor})` : `ocs dm ${m.actor} "…"`;
}

export async function memberReady(transport: Transport, env = process.env): Promise<string[]> {
  const id = env.SFLOW_TEAM_ID, role = env.SFLOW_ROLE, token = env.SFLOW_TOKEN;
  if (!id || !role || !token) throw new Error("run this through the member wrapper named in your Session Flow prompt (<team>/<role>/member ready), not through plain sflow");
  const team = loadTeam(id), m = team.members[role];
  if (!m || token.length !== m.token.length || !timingSafeEqual(Buffer.from(token), Buffer.from(m.token))) throw new Error("invalid member capability");
  const actor = await transport.whoami(m.agent as Agent);
  if (m.status === "ready") {
    if (m.actor !== actor) throw new Error(`member ${role} is already bound to ${m.actor}`);
  } else if (m.status !== "launching") throw new Error(`member ${role} is ${m.status}; nothing to do`);
  else {
    const pane = await checkPane(team, m, env);
    if (pane.refuse) throw new Error(`refused: ${pane.refuse}`);
    const { refuse: _r, ...evidence } = pane;
    const e: Omit<ReadyEvent, "proof"> = { type: "sflow.team", version: 1, teamId: team.id, role, actor, status: "ready", pane: evidence };
    await transport.send(team.channel, { ...e, proof: readyProof(e, m.token) }, actor);
  }
  return [`You are ${role} in team ${team.id}. Your OCS id: ${actor}.`, "Team:", ...roster(team).filter(l => !l.startsWith(`  ${role} `)),
    "Wait for messages; answer each with the Reply line it carries."];
}

// ---- driver side: reconcile ----

function isReady(body: unknown): body is ReadyEvent {
  const e = body as ReadyEvent;
  return !!e && typeof e === "object" && e.type === "sflow.team" && e.version === 1 && e.status === "ready" && typeof e.role === "string" &&
    typeof e.actor === "string" && !!e.pane && typeof e.pane === "object" && typeof e.pane.verified === "boolean";
}
function parse(row: Message): unknown { try { return JSON.parse(row.body); } catch { return null; } }
// Binds members to the native sessions that proved they are them, and marks members whose
// session disappeared without sflow stopping it. Never launches or relaunches anything.
export async function reconcileTeam(team: Team, transport: Transport, tmux: Pick<TeamTmux, "exists"> = new TeamTmux()): Promise<boolean> {
  let changed = false;
  const open = Object.values(team.members).filter(m => m.status === "launching" || m.status === "ready");
  if (!open.length) return false;
  const rows = open.some(m => m.status === "launching") ? await transport.read(team.channel, sender(team)) : [];
  for (const row of rows) {
    const e = parse(row);
    if (!isReady(e) || e.teamId !== team.id) continue;
    const m = team.members[e.role];
    if (!m || m.status !== "launching" || row.from !== e.actor || !validReady(e, m.token) || !nativeActor(e.actor, m.agent)) continue;
    if (Object.values(team.members).some(o => o !== m && o.actor === e.actor && o.status !== "closed")) continue;
    if (!await tmux.exists(team, m)) continue;
    Object.assign(m, { status: "ready", actor: e.actor, pane: e.pane, readyAt: Date.now() }); delete m.error;
    changed = true;
  }
  for (const m of open) {
    if (await tmux.exists(team, m)) continue;
    m.status = "uncertain"; m.error = "its tmux session is gone, and sflow did not stop it"; changed = true;
  }
  if (changed) saveTeam(team);
  return changed;
}

// ---- send / stop / gc ----

export async function sendToMember(teamId: string, role: string, text: string, from: string | null, transport: Transport, tmux = new TeamTmux()) {
  if (!text.trim()) throw new Error("empty message");
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error("messages are limited to 64 KiB");
  return withTeam(teamId, async team => {
    await reconcileTeam(team, transport, tmux);
    const m = team.members[role];
    if (!m) throw new Error(`no member ${role} in team ${team.id}`);
    if (m.status !== "ready") throw new Error(`member ${role} is ${m.status}${m.error ? ` (${m.error})` : ""}; send only to a ready member`);
    const body = `[sflow team ${team.id}] Message for ${role} from ${from ?? "a person at the terminal"}:\n${text}\n\n` +
      (from ? `Reply: ocs dm ${from} "<your reply>"` : "Reply here, in this session; the sender reads it with sflow team logs or attach.");
    // The log entry first: if it cannot be written nothing was delivered, so the caller may send again.
    await transport.send(team.channel, { type: "sflow.team.message", version: 1, teamId: team.id, to: role, from, text }, sender(team));
    const file = join(team.dir, role, `message-${Date.now()}.txt`);
    writeFileSync(file, body, { mode: 0o600 });
    await tmux.paste(team, m, file);
    return { delivered: true, to: role, actor: m.actor };
  });
}

export async function stopMember(teamId: string, role: string, tmux = new TeamTmux()) {
  return withTeam(teamId, async team => {
    const m = team.members[role];
    if (!m) throw new Error(`no member ${role} in team ${team.id}`);
    if (m.status === "closed") return m;
    if (await tmux.exists(team, m)) {
      writeFileSync(join(team.dir, role, "terminal.txt"), await tmux.screen(team, m, 2000), { mode: 0o600 });
      await tmux.kill(team, m);
    }
    m.status = "closed"; m.closedAt = Date.now(); saveTeam(team);
    return m;
  });
}

export interface GcCandidate { team: string; role?: string; reason: string }
// Lists closed members (and teams with nothing else left). Removes them only with apply.
// Members that may be working are never candidates: no idle or silence-based expiry.
export async function gcTeams(apply: boolean, tmux = new TeamTmux()): Promise<GcCandidate[]> {
  const out: GcCandidate[] = [];
  for (const id of listTeams()) {
    await withTeam(id, async team => {
      const closed = Object.values(team.members).filter(m => m.status === "closed");
      for (const m of closed) out.push({ team: id, role: m.role, reason: `closed ${new Date(m.closedAt ?? m.launch.attemptedAt).toISOString()}` });
      const empty = closed.length === Object.keys(team.members).length;
      if (empty) out.push({ team: id, reason: "no open members" });
      if (!apply) return;
      for (const m of closed) { rmSync(join(team.dir, m.role), { recursive: true, force: true }); delete team.members[m.role]; }
      saveTeam(team);
      if (empty) { await tmux.killServer(team); rmSync(dirname(team.socket), { recursive: true, force: true }); }
    });
    if (apply && out.some(c => c.team === id && !c.role)) rmSync(teamDir(id), { recursive: true, force: true });
  }
  return out;
}

export async function waitingMenu(team: Team, m: Member, tmux = new TeamTmux()): Promise<Menu | null> {
  try { return parseMenu(await tmux.screen(team, m)); } catch { return null; }
}
