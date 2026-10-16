import { test, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcTeams, loadTeam, memberReady, readyProof, reconcileTeam, saveTeam, sendToMember, spawnMember, stopMember, TeamTmux, validateSpawn,
  type Member, type ReadyEvent, type Team } from "../src/team";
import { OcsTransport } from "../src/ocs";
import type { Message, Transport } from "../src/types";
import { tmuxWorks } from "./tmux";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const saved = { ...process.env };
let base: string, project: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "sf-team-")));
  process.env.SFLOW_HOME = join(base, "state"); process.env.OCS_HOME = join(base, "ocs");
  project = join(base, "project"); mkdirSync(project);
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(base, { recursive: true, force: true });
});

const CODEX_A = "codex-11111111-2222-4333-8444-555555555555", CODEX_B = "codex-22222222-2222-4333-8444-555555555555";
class Rows implements Transport {
  rows: Message[] = []; sent: { channel: string; body: unknown; as: string }[] = []; me = CODEX_A;
  async read() { return this.rows; }
  async send(channel: string, body: unknown, as: string) { this.sent.push({ channel, body, as }); this.rows.push({ seq: this.rows.length + 1, from: as, body: JSON.stringify(body) }); }
  async whoami() { return this.me; }
}
// No tmux: start records the call, liveness is whatever the test says.
function fakeTmux(alive: Record<string, boolean> = {}) {
  const t = new TeamTmux("/nonexistent/tmux"), pasted: string[] = [];
  Object.assign(t, {
    start: async () => {}, exists: async (_t: Team, m: Member) => alive[m.role] ?? true,
    paste: async (_t: Team, _m: Member, file: string) => { pasted.push(readFileSync(file, "utf8")); },
    screen: async () => "last screen\n", kill: async () => {}, killServer: async () => {},
  });
  return { tmux: t, pasted, alive };
}
const spawn = (role: string, tmux: TeamTmux, extra: object = {}) =>
  spawnMember({ team: "t", role, agent: "codex", cwd: project, cli: ["true"], ...extra }, tmux);
function ready(team: Team, role: string, actor: string, token = team.members[role].token, pane = { verified: true, paneId: "%0" }): Message {
  const e: Omit<ReadyEvent, "proof"> = { type: "sflow.team", version: 1, teamId: team.id, role, actor, status: "ready", pane };
  return { seq: 1, from: actor, body: JSON.stringify({ ...e, proof: readyProof(e, token) }) };
}

test("spawn validates the role, agent, cwd and write rules before anything is created", () => {
  const o = { team: "t", role: "rev", agent: "codex", cwd: project, cli: ["true"] };
  expect(validateSpawn(o).cwd).toBe(project);
  expect(() => validateSpawn({ ...o, role: "Rev" })).toThrow("role must match");
  expect(() => validateSpawn({ ...o, agent: "agy" })).toThrow("cannot tell two agy members apart");
  expect(() => validateSpawn({ ...o, agent: "gpt" })).toThrow("claude, codex, pi");
  expect(() => validateSpawn({ ...o, cwd: join(base, "missing") })).toThrow("not a directory");
  expect(() => validateSpawn({ ...o, write: true })).toThrow("inside a Git checkout");
  mkdirSync(process.env.SFLOW_HOME!, { recursive: true });
  expect(() => validateSpawn({ ...o, cwd: process.env.SFLOW_HOME! })).toThrow("overlaps");
  expect(existsSync(join(process.env.SFLOW_HOME!, "teams"))).toBe(false);
});

test("a spawned member is recorded as launching with its own wrapper, prompt and private socket", async () => {
  const { tmux } = fakeTmux();
  const { team, member } = await spawn("rev", tmux, { instructions: "Review for races." });
  expect(member).toMatchObject({ role: "rev", agent: "codex", status: "launching", policy: "read-only", session: "sft-rev", cwd: project });
  expect(member.launch.startedAt).toBeGreaterThan(0);
  const wrapper = readFileSync(join(team.dir, "rev", "member"), "utf8");
  expect(wrapper).toContain("SFLOW_TEAM_ID='t'"); expect(wrapper).toContain(`SFLOW_TOKEN='${member.token}'`); expect(wrapper).toContain("'true' 'team' \"$@\"");
  const prompt = readFileSync(join(team.dir, "rev", "bootstrap.txt"), "utf8");
  expect(prompt).toContain(`First run '${join(team.dir, "rev", "member")}' ready once`);
  expect(prompt).toContain("Do not start work on your own");
  expect(prompt).toContain("Role instructions (flag):\nReview for races.");
  // A read-only Codex member's sandbox may write its team directories and OCS, not the project.
  const start = readFileSync(join(team.dir, "rev", "start.sh"), "utf8");
  expect(start).toContain("'--add-dir' '" + join(team.dir, ".protocol") + "'"); expect(start).not.toContain(`'--add-dir' '${project}'`);
  expect(loadTeam("t").socket).toMatch(/\/sf-t-[0-9a-f]{12}\/tmux\.sock$/);
  // One role, one open member.
  await expect(spawn("rev", tmux)).rejects.toThrow("already exists (launching)");
});

test("a launch tmux refused leaves nothing running and the member closed; an unknown outcome is uncertain", async () => {
  const { tmux, alive } = fakeTmux({ a: false });
  Object.assign(tmux, { start: async () => { throw new Error("tmux exited 1: boom"); } });
  await expect(spawn("a", tmux)).rejects.toThrow("launch failed");
  expect(loadTeam("t").members.a.status).toBe("closed");
  Object.assign(tmux, { exists: async () => { throw new Error("cannot inspect"); } });
  alive.b = true;
  const { member } = await spawn("b", tmux);
  expect(member.status).toBe("uncertain");
  expect(member.error).toContain("launch outcome unknown");
});

test("only the member's own signed ready report binds it, once, to one native session", async () => {
  const { tmux } = fakeTmux();
  await spawn("a", tmux); await spawn("b", tmux, { agent: "claude" });
  const tr = new Rows(); let team = loadTeam("t");
  // Wrong token, wrong agent shape, a different sender than the actor: all ignored.
  tr.rows = [ready(team, "a", CODEX_A, "0".repeat(48)), ready(team, "b", CODEX_B), { ...ready(team, "a", CODEX_A), from: CODEX_B }];
  expect(await reconcileTeam(team, tr, tmux)).toBe(false);
  expect(team.members.a.status).toBe("launching"); expect(team.members.b.status).toBe("launching");
  tr.rows = [ready(team, "a", CODEX_A)];
  expect(await reconcileTeam(team, tr, tmux)).toBe(true);
  team = loadTeam("t");
  expect(team.members.a).toMatchObject({ status: "ready", actor: CODEX_A, pane: { verified: true, paneId: "%0" } });
  // A later report from another session cannot rebind it, and one session cannot be two members.
  tr.rows = [ready(team, "a", CODEX_B), ready(team, "b", "claude-aaaaaaaa"), ready(team, "b", CODEX_A)];
  await reconcileTeam(team, tr, tmux);
  expect(team.members.a.actor).toBe(CODEX_A);
  expect(team.members.b).toMatchObject({ status: "ready", actor: "claude-aaaaaaaa" });
});

test("a member whose session vanished without sflow stopping it becomes uncertain and is never restarted", async () => {
  const { tmux, alive } = fakeTmux();
  let starts = 0; const start = tmux.start.bind(tmux);
  Object.assign(tmux, { start: async (...a: Parameters<TeamTmux["start"]>) => { starts++; return start(...a); } });
  await spawn("a", tmux);
  const team = loadTeam("t"), tr = new Rows();
  tr.rows = [ready(team, "a", CODEX_A)]; await reconcileTeam(team, tr, tmux);
  alive.a = false;
  await reconcileTeam(team, tr, tmux);
  expect(loadTeam("t").members.a).toMatchObject({ status: "uncertain", error: "its tmux session is gone, and sflow did not stop it" });
  await reconcileTeam(loadTeam("t"), tr, tmux);
  expect(starts).toBe(1);
  await expect(spawn("a", tmux)).rejects.toThrow("is uncertain");
});

test("ready runs only through the member wrapper and refuses a pane in another tmux server", async () => {
  const { tmux } = fakeTmux();
  const { team, member } = await spawn("a", tmux);
  const tr = new Rows(), env = { SFLOW_TEAM_ID: "t", SFLOW_ROLE: "a", SFLOW_TOKEN: member.token };
  await expect(memberReady(tr, {})).rejects.toThrow("member wrapper");
  await expect(memberReady(tr, { ...env, SFLOW_TOKEN: "x".repeat(48) })).rejects.toThrow("invalid member capability");
  // The pane says it lives in another tmux server: a definite mismatch.
  mkdirSync(join(team.socket, ".."), { recursive: true }); writeFileSync(team.socket, "");
  const other = join(base, "other.sock"); writeFileSync(other, "");
  await expect(memberReady(tr, { ...env, TMUX: `${other},1,0`, TMUX_PANE: "%0" })).rejects.toThrow("another tmux server");
  expect(tr.sent).toHaveLength(0);
  // A sandbox that hides tmux leaves the pane unverified, which is recorded, not refused.
  const lines = await memberReady(tr, env);
  expect(lines[0]).toBe(`You are a in team t. Your OCS id: ${CODEX_A}.`);
  expect(tr.sent[0].as).toBe(CODEX_A);
  expect((tr.sent[0].body as ReadyEvent).pane).toEqual({ verified: false, reason: "TMUX/TMUX_PANE not visible to this command" });
  await reconcileTeam(loadTeam("t"), tr, tmux);
  expect(loadTeam("t").members.a).toMatchObject({ status: "ready", actor: CODEX_A, pane: { verified: false } });
  // Run again by the same session it only prints; by another it is refused.
  await memberReady(tr, env); expect(tr.sent).toHaveLength(1);
  tr.me = CODEX_B; await expect(memberReady(tr, env)).rejects.toThrow("already bound");
});

test("send pastes once into a ready member, logs it on the team channel and names who to reply to", async () => {
  const { tmux, pasted } = fakeTmux();
  await spawn("a", tmux);
  const tr = new Rows();
  await expect(sendToMember("t", "a", "hi", null, tr, tmux)).rejects.toThrow("send only to a ready member");
  tr.rows = [ready(loadTeam("t"), "a", CODEX_A)];
  expect(await sendToMember("t", "a", "Review src/x.ts", "claude-aaaaaaaa", tr, tmux)).toMatchObject({ delivered: true, actor: CODEX_A });
  expect(pasted).toHaveLength(1);
  expect(pasted[0]).toContain("Message for a from claude-aaaaaaaa:\nReview src/x.ts");
  expect(pasted[0]).toContain('Reply: ocs dm claude-aaaaaaaa "<your reply>"');
  expect(tr.sent.at(-1)).toMatchObject({ channel: "sflow-team-t", as: "sflow-team-t", body: { type: "sflow.team.message", to: "a", text: "Review src/x.ts" } });
  await sendToMember("t", "a", "From the terminal", null, tr, tmux);
  expect(pasted[1]).toContain("Reply here, in this session");
  // A paste that fails part-way is reported uncertain and not retried.
  Object.assign(tmux, { paste: async () => { pasted.push("tried"); throw Object.assign(new Error("delivery uncertain: x"), { uncertain: true }); } });
  await expect(sendToMember("t", "a", "again", null, tr, tmux)).rejects.toThrow("delivery uncertain");
  expect(pasted.filter(p => p === "tried")).toHaveLength(1);
  await expect(sendToMember("t", "nobody", "x", null, tr, tmux)).rejects.toThrow("no member nobody");
});

test("stop keeps the terminal output and closes the member; gc lists before it removes", async () => {
  const { tmux } = fakeTmux();
  await spawn("a", tmux); await spawn("b", tmux);
  const m = await stopMember("t", "a", tmux);
  expect(m.status).toBe("closed");
  expect(readFileSync(join(loadTeam("t").dir, "a", "terminal.txt"), "utf8")).toBe("last screen\n");
  expect(await gcTeams(false, tmux)).toEqual([{ team: "t", role: "a", reason: expect.stringContaining("closed ") }]);
  expect(loadTeam("t").members.a).toBeDefined();
  await gcTeams(true, tmux);
  expect(loadTeam("t").members.a).toBeUndefined(); expect(loadTeam("t").members.b.status).toBe("launching");
  // A closed role can be spawned again; an empty team goes away entirely on --apply.
  await stopMember("t", "b", tmux);
  const found = await gcTeams(true, tmux);
  expect(found.map(c => c.role ?? "(team)")).toEqual(["b", "(team)"]);
  expect(existsSync(join(process.env.SFLOW_HOME!, "teams", "t"))).toBe(false);
});

test("a team record from a newer sflow is refused, not reinterpreted", async () => {
  const { tmux } = fakeTmux();
  const { team } = await spawn("a", tmux);
  saveTeam({ ...team, schemaVersion: 2 as 1 });
  expect(() => loadTeam("t")).toThrow("newer sflow");
  writeFileSync(join(team.dir, "team.json"), JSON.stringify({ ...team, kind: "run" }));
  expect(() => loadTeam("t")).toThrow("not a team record");
});

// The whole path in a real tmux server: a fake codex that runs the member wrapper's ready from
// inside its pane, a fake ocs that stores channel rows, then a paste and a stop.
test.skipIf(!tmuxWorks)("a real member reports ready from its own pane, receives a paste and is stopped", async () => {
  const bin = join(base, "bin"), out = join(base, "out"); mkdirSync(bin); mkdirSync(out);
  writeFileSync(join(bin, "codex"), `#!/bin/sh
for a; do last="$a"; done
w=$(printf '%s' "$last" | sed -n "s/^First run '\\([^']*\\)' ready once.*/\\1/p")
CODEX_THREAD_ID=11111111-2222-4333-8444-555555555555 "$w" ready > "${out}/ready.txt" 2>&1
while IFS= read -r line; do printf '%s\\n' "$line" >> "${out}/got.txt"; done
`); chmodSync(join(bin, "codex"), 0o755);
  const rows = join(out, "rows.json");
  writeFileSync(join(bin, "ocs"), `#!${process.execPath}
const fs = require("fs"), [cmd, ...a] = process.argv.slice(2), file = ${JSON.stringify(rows)};
const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
if (cmd === "whoami") console.log(JSON.stringify({ id: "codex-11111111" }));
else if (cmd === "read") console.log(JSON.stringify(all));
else if (cmd === "send") { all.push({ seq: all.length + 1, from: a[a.indexOf("--as") + 1], body: a[1] }); fs.writeFileSync(file, JSON.stringify(all)); }
`); chmodSync(join(bin, "ocs"), 0o755);
  process.env.PATH = `${bin}:${saved.PATH}`; process.env.SFLOW_OCS_BIN = join(bin, "ocs");
  const tmux = new TeamTmux(), tr = new OcsTransport(join(bin, "ocs"));
  const { team } = await spawnMember({ team: "live", role: "rev", agent: "codex", cwd: project, cli: [process.execPath, CLI] }, tmux);
  try {
    let m = team.members.rev;
    for (let i = 0; i < 200 && m.status === "launching"; i++) { await Bun.sleep(50); const t = loadTeam("live"); await reconcileTeam(t, tr, tmux); m = t.members.rev; }
    expect(readFileSync(join(out, "ready.txt"), "utf8")).toContain(`Your OCS id: ${CODEX_A}`);
    expect(m).toMatchObject({ status: "ready", actor: CODEX_A, pane: { verified: true } });
    await sendToMember("live", "rev", "look at the parser", "claude-aaaaaaaa", tr, tmux);
    let got = "";
    for (let i = 0; i < 100 && !got.includes("Reply:"); i++) { await Bun.sleep(50); got = existsSync(join(out, "got.txt")) ? readFileSync(join(out, "got.txt"), "utf8") : ""; }
    expect(got).toContain("look at the parser"); expect(got).toContain("Reply: ocs dm claude-aaaaaaaa");
    await stopMember("live", "rev", tmux);
    expect(await tmux.exists(loadTeam("live"), loadTeam("live").members.rev)).toBe(false);
    expect(existsSync(join(loadTeam("live").dir, "rev", "terminal.txt"))).toBe(true);
  } finally { await tmux.killServer(loadTeam("live")); }
}, 30_000);
