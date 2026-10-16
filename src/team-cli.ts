import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OcsTransport } from "./ocs";
import { preflight, requiredTools } from "./preflight";
import { command } from "./process";
import { address, gcTeams, listTeams, loadTeam, memberReady, reconcileTeam, roster, sendToMember, spawnMember, stopMember, TeamTmux,
  validateSpawn, waitingMenu, withTeam, type Member, type Team } from "./team";

const USAGE = `sflow team spawn <role> --agent claude|codex|pi [--team t] [--cwd dir] [--model m] [--write]
                 [--instructions "…" | --instructions-file f] [--no-wait] [--wait-seconds n] [--json]
                                     start one long-lived member and print its OCS id once it is ready
sflow team ls [--team t] [--json]     members, their status and how to reach them (all teams without --team)
sflow team send <role> <text> [--team t] [--from <ocs address>]
                                     paste a message into the member's session (works for Codex too)
sflow team logs <role> [--team t]     the member's recent terminal output
sflow team attach <role> [--team t]   join the member's session (detach with Ctrl-b d)
sflow team stop <role>|--all [--team t]   stop members; their terminal output is kept
sflow team gc [--apply]              list closed members and empty teams; --apply removes them

The team defaults to "default". A team has no workflow and no completion guarantee: a lead (you,
or any agent session) hands out work by message, and members answer the sender. Claude and Pi
members also wake on \`ocs dm <their OCS id>\`; Codex CLI members are reached only with team send.
Members are read-only unless --write, which lets them edit cwd in place (no worktree).`;

function flag(list: string[], name: string): string | undefined {
  const i = list.indexOf(name);
  if (i < 0) return undefined;
  const v = list[i + 1];
  if (v === undefined || (v.startsWith("--") && name !== "--instructions")) throw new Error(`${name} needs a value`);
  list.splice(i, 2); return v;
}
function bool(list: string[], name: string): boolean {
  const i = list.indexOf(name);
  if (i < 0) return false;
  list.splice(i, 1); return true;
}
function rest(list: string[], count: number, usage: string): string[] {
  const unknown = list.find(a => a.startsWith("--"));
  if (unknown) throw new Error(`unknown option ${unknown}\n${usage}`);
  if (list.length !== count) throw new Error(usage);
  return list;
}
function run(argv: string[]): Promise<number> {
  return new Promise((res, rej) => { const c = spawn(argv[0], argv.slice(1), { stdio: "inherit" }); c.on("error", rej); c.on("exit", code => res(code ?? 1)); });
}
const defaultTeam = (list: string[]) => flag(list, "--team") ?? process.env.SFLOW_TEAM_ID ?? "default";

function publicMember(team: Team, m: Member) {
  return { team: team.id, role: m.role, agent: m.agent, ...(m.model ? { model: m.model } : {}), status: m.status, policy: m.policy, cwd: m.cwd,
    ...(m.actor ? { actor: m.actor } : {}), reach: address(team, m), ...(m.pane ? { pane: m.pane } : {}), ...(m.error ? { error: m.error } : {}) };
}
async function refreshed(id: string, transport: OcsTransport, tmux: TeamTmux): Promise<Team> {
  return withTeam(id, async team => { await reconcileTeam(team, transport, tmux); return team; });
}

export async function teamCommand(args: string[], cli: string[], transport = new OcsTransport(), tmux = new TeamTmux()): Promise<number> {
  const [sub, ...list] = args;
  if (!sub || sub === "help" || sub === "--help") { console.log(USAGE); return 0; }
  if (sub === "ready") {
    for (const line of await memberReady(transport)) console.log(line);
    return 0;
  }
  if (sub === "spawn") {
    const json = bool(list, "--json"), noWait = bool(list, "--no-wait"), write = bool(list, "--write");
    const team = defaultTeam(list), agent = flag(list, "--agent"), model = flag(list, "--model"), cwd = flag(list, "--cwd") ?? process.cwd();
    const waitSeconds = Number(flag(list, "--wait-seconds") ?? 90);
    const text = flag(list, "--instructions"), file = flag(list, "--instructions-file");
    const [role] = rest(list, 1, "sflow team spawn <role> --agent claude|codex|pi [options]");
    if (!agent) throw new Error("--agent is required (claude, codex or pi)");
    if (text !== undefined && file !== undefined) throw new Error("use either --instructions or --instructions-file");
    if (!Number.isInteger(waitSeconds) || waitSeconds < 5 || waitSeconds > 600) throw new Error("--wait-seconds is 5 to 600");
    const options = { team, role, agent, model, cwd, write, cli,
      instructions: file !== undefined ? readFileSync(resolve(file), "utf8") : text, instructionsSource: file !== undefined ? resolve(file) : undefined };
    // Clear rule errors (an unsupported agent, a bad role) before "not installed" ones.
    validateSpawn(options);
    await preflight(requiredTools(tmux.binary, transport.binary, [agent]));
    const { member } = await spawnMember(options, tmux);
    if (!json) console.error(`started ${role} (${member.agent}) in team ${team}; waiting for it to report ready…`);
    if (noWait) { if (json) console.log(JSON.stringify(publicMember(loadTeam(team), member), null, 2)); return 0; }
    // Readiness comes only from the member's own signed ready report. A menu on its screen (trust,
    // login) is shown once; nothing here answers it, stops the member or starts it again.
    const end = Date.now() + waitSeconds * 1000;
    let shown = "";
    for (;;) {
      const t = await refreshed(team, transport, tmux), m = t.members[role];
      if (m.status !== "launching") {
        if (json) console.log(JSON.stringify(publicMember(t, m), null, 2));
        else console.log(m.status === "ready" ? `${role} is ready. OCS id: ${m.actor}\nreach it: ${address(t, m)}` : `${role} is ${m.status}: ${m.error ?? ""}`);
        return m.status === "ready" ? 0 : 1;
      }
      const menu = await waitingMenu(t, m, tmux);
      if (menu && menu.id !== shown) {
        shown = menu.id;
        console.error(`${role} is waiting on its screen:\n  ${menu.question.join("\n  ")}\n${menu.options.map((o, i) => `  ${i + 1}. ${o}`).join("\n")}\nanswer it with: sflow team attach ${role} --team ${team}`);
      }
      if (Date.now() > end) {
        if (json) console.log(JSON.stringify(publicMember(t, m), null, 2));
        console.error(`${role} has not reported ready within ${waitSeconds}s; it is still running. Look with: sflow team logs ${role} --team ${team} (or attach); check again with: sflow team ls --team ${team}`);
        return 2;
      }
      await Bun.sleep(Number(process.env.SFLOW_POLL_MS ?? 1000));
    }
  }
  if (sub === "ls") {
    const json = bool(list, "--json"), named = flag(list, "--team") ?? process.env.SFLOW_TEAM_ID;
    rest(list, 0, "sflow team ls [--team t] [--json]");
    const teams: Team[] = [];
    for (const id of named ? [named] : listTeams()) teams.push(await refreshed(id, transport, tmux));
    if (json) { console.log(JSON.stringify(teams.flatMap(t => Object.values(t.members).map(m => publicMember(t, m))), null, 2)); return 0; }
    if (!teams.length) { console.log("no teams; start one with: sflow team spawn <role> --agent codex"); return 0; }
    for (const t of teams) {
      console.log(`team ${t.id}`);
      const lines = roster(t), closed = Object.values(t.members).filter(m => m.status === "closed").length;
      console.log(lines.length ? lines.join("\n") : "  (no open members)");
      if (closed) console.log(`  ${closed} closed (sflow team gc lists them)`);
    }
    return 0;
  }
  if (sub === "send") {
    const team = defaultTeam(list);
    let from = flag(list, "--from") ?? null;
    const [role, text] = rest(list, 2, "sflow team send <role> <text> [--team t] [--from <ocs address>]");
    // Replies go to whoever sent this. Inside an agent session that is its OCS id; at a plain
    // terminal there is none, and the member answers in its own session.
    if (!from) {
      const r = await command([transport.binary, "whoami", "--json"]).catch(() => null);
      if (r?.code === 0) try { const id = JSON.parse(r.stdout).id; if (typeof id === "string" && id) from = id; } catch {}
    }
    try { const r = await sendToMember(team, role, text, from, transport, tmux); console.log(`delivered to ${role}${from ? `; it replies to ${from}` : ""}`); return r.delivered ? 0 : 1; }
    catch (e) { if ((e as { uncertain?: boolean }).uncertain) { console.error(`${(e as Error).message}\nnot retried; look with: sflow team logs ${role} --team ${team}`); return 3; } throw e; }
  }
  if (sub === "logs" || sub === "attach") {
    const team = defaultTeam(list);
    const [role] = rest(list, 1, `sflow team ${sub} <role> [--team t]`);
    const t = loadTeam(team), m = t.members[role];
    if (!m) throw new Error(`no member ${role} in team ${team}`);
    if (!await tmux.exists(t, m)) throw new Error(`${role} has no running session${m.status === "closed" ? "; its last output is in " + resolve(t.dir, role, "terminal.txt") : ""}`);
    if (sub === "logs") { process.stdout.write(await tmux.screen(t, m, 2000)); return 0; }
    return await run(tmux.attachArgs(t, m));
  }
  if (sub === "stop") {
    const team = defaultTeam(list), all = bool(list, "--all");
    const roles = all ? (rest(list, 0, "sflow team stop --all [--team t]"), Object.values(loadTeam(team).members).filter(m => m.status !== "closed").map(m => m.role))
      : rest(list, 1, "sflow team stop <role>|--all [--team t]");
    for (const role of roles) { await stopMember(team, role, tmux); console.log(`stopped ${role}`); }
    if (!roles.length) console.log("nothing to stop");
    return 0;
  }
  if (sub === "gc") {
    const apply = bool(list, "--apply");
    rest(list, 0, "sflow team gc [--apply]");
    const found = await gcTeams(apply, tmux);
    if (!found.length) { console.log("nothing to clean up"); return 0; }
    for (const c of found) console.log(`${apply ? "removed" : "would remove"} ${c.team}${c.role ? `/${c.role}` : ""}: ${c.reason}`);
    if (!apply) console.log("run with --apply to remove them");
    return 0;
  }
  throw new Error(`unknown team command ${sub}\n${USAGE}`);
}
