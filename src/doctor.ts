import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { command } from "./process";
import { AGENTS, type Workflow } from "./types";
import { freezeHosts, hostPreflight } from "./hosts-cli";
import { candidates, SshLink, REMOTE_PROTOCOL, type Hello } from "./hosts";

export interface Check { name: string; level: "ok" | "warn" | "fail" | "skip"; detail: string; fix?: string }

async function run(argv: string[], timeoutMs = 15000) {
  return await command(argv, { timeoutMs }).catch((e: Error) => ({ code: 1, stdout: "", stderr: e.message }));
}
function firstLine(text: string) { return text.trim().split("\n")[0] ?? ""; }
function atLeast(version: string, min: number[]) {
  const v = (/(\d+)\.(\d+)\.(\d+)/.exec(version) ?? []).slice(1).map(Number);
  if (v.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

// Login status comes only from each CLI's public status command: no credential files are read,
// nothing is printed from them, and no model request is made.
const LOGIN: Record<string, { argv: string[]; ok: (out: string) => boolean; fix: string } | undefined> = {
  claude: { argv: ["claude", "auth", "status", "--json"], ok: out => { try { return JSON.parse(out).loggedIn === true; } catch { return false; } }, fix: "claude auth login" },
  codex: { argv: ["codex", "login", "status"], ok: out => /logged in/i.test(out) && !/not logged in/i.test(out), fix: "codex login" },
};

export async function doctor(opts: { tmux: string; ocs: string; agents?: string[]; workflow?: Workflow; env?: NodeJS.ProcessEnv; home?: string }): Promise<Check[]> {
  const env = opts.env ?? process.env, home = opts.home ?? homedir();
  const selected = opts.workflow ? opts.workflow.steps.filter(s => !s.host).map(s => s.agent) : opts.agents;
  const required = new Set(selected?.filter(a => a !== "command") ?? []);
  const checks: Check[] = [];
  const tmux = await run([opts.tmux, "-V"]);
  checks.push(tmux.code ? { name: "tmux", level: "fail", detail: `not usable (${opts.tmux})`, fix: "brew install tmux  (or: sudo apt install tmux; or set SFLOW_TMUX_BIN)" }
    : { name: "tmux", level: "ok", detail: firstLine(tmux.stdout) });
  const ocs = await run([opts.ocs, "version"]);
  if (ocs.code) checks.push({ name: "ocs", level: "fail", detail: `not usable (${opts.ocs})`, fix: "curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | sh" });
  else if (!atLeast(ocs.stdout, [0, 8, 0])) checks.push({ name: "ocs", level: "fail", detail: `${firstLine(ocs.stdout)} is older than 0.8.0`, fix: "ocs upgrade" });
  else checks.push({ name: "ocs", level: "ok", detail: firstLine(ocs.stdout) });

  for (const agent of selected !== undefined ? [...required] : AGENTS) {
    const needed = required.has(agent);
    const version = await run([agent, "--version"]);
    if (version.code) {
      checks.push({ name: agent, level: needed ? "fail" : "skip", detail: needed ? "a step uses it, but it is not installed or does not start" : "not installed (only needed if a workflow uses it)",
        fix: `install the ${agent} CLI and sign in once interactively` });
      continue;
    }
    checks.push({ name: agent, level: "ok", detail: firstLine(version.stdout || version.stderr) });
    const login = LOGIN[agent];
    if (login) {
      const r = await run(login.argv);
      checks.push(r.code === 0 && login.ok(r.stdout.trim() ? r.stdout : r.stderr) ? { name: `${agent} login`, level: "ok", detail: "signed in" }
        : { name: `${agent} login`, level: needed ? "fail" : "warn", detail: "not signed in, or the status command failed", fix: login.fix });
    } else {
      checks.push({ name: `${agent} login`, level: "skip", detail: "no public status command; sign-in problems show on the worker screen" });
    }
    if (agent === "pi") {
      const dir = env.PI_CODING_AGENT_DIR && isAbsolute(env.PI_CODING_AGENT_DIR) ? env.PI_CODING_AGENT_DIR : join(home, ".pi", "agent");
      checks.push(existsSync(join(dir, "extensions", "ocs.ts")) ? { name: "pi ocs extension", level: "ok", detail: "installed" }
        : { name: "pi ocs extension", level: needed ? "fail" : "warn", detail: "missing; Pi workers cannot report without it", fix: "ocs doctor --fix" });
    }
    if (agent === "claude") {
      const workspace = join(env.SFLOW_HOME ?? join(home, ".local/state/session-flow"), "workspaces", "claude");
      checks.push({ name: "claude workspace", level: "ok", detail: existsSync(workspace)
        ? `${workspace} (read-only Claude steps start here; Claude asks once to trust it)`
        : `${workspace} will be created; the first read-only Claude step asks once to trust it (an empty folder sflow owns)` });
    }
  }
  if (opts.workflow) {
    let hosts: ReturnType<typeof freezeHosts>;
    let hostsOK = true;
    try {
      hosts = freezeHosts(opts.workflow);
      await hostPreflight(opts.workflow, hosts);
      if (hosts) checks.push({ name: "hosts", level: "ok", detail: "each remote step has a host with matching protocol and required tools" });
    } catch (e) { hostsOK = false; checks.push({ name: "hosts", level: "fail", detail: (e as Error).message, fix: "sflow hosts check" }); }
    for (const step of opts.workflow.steps.filter(s => s.agent === "command")) {
      const program = step.command![0], name = `${step.id} command`;
      if (step.workspace) {
        checks.push({ name, level: "skip", detail: `${program}: checked when the dependency worktree is available; no command is executed by doctor` });
      } else if (!step.host) {
        const relative = !isAbsolute(program) && program.includes("/");
        const path = step.input === "none" && relative ? null : Bun.which(program, { cwd: step.cwd, PATH: env.PATH });
        checks.push({ name, level: path ? "ok" : "fail", detail: path ? `${path} (found, not executed)` : `${program} is not executable ${step.input === "none" ? "in an empty working directory" : "on this machine"}` });
      } else if (!hostsOK || !hosts) {
        checks.push({ name, level: "skip", detail: "target hosts could not be checked" });
      } else if (!isAbsolute(program) && program.includes("/")) {
        checks.push({ name, level: step.input === "none" ? "fail" : "skip", detail: `${program}: ${step.input === "none" ? "an empty working directory has no relative executable" : "checked in the transferred snapshot when the job starts"}` });
      } else {
        const found: string[] = [], errors: string[] = [];
        for (const host of candidates(step.host, hosts)) {
          try {
            const link = new SshLink(host, hosts[host]);
            const hello = await link.call<Hello>("hello", {}, 20_000);
            if (hello.protocol !== REMOTE_PROTOCOL || (step.input !== "none" && !hello.tools.git)) {
              errors.push(`${host}: incompatible protocol or missing Git`); continue;
            }
            const r = await link.call<{ path: string | null }>("command-check", { program }, 20_000);
            if (r.path) found.push(`${host}: ${r.path}`); else errors.push(`${host}: ${program} not found`);
          } catch (e) { errors.push(`${host}: ${(e as Error).message}`); }
        }
        checks.push({ name, level: found.length ? "ok" : "fail", detail: found.length ? `${found.join("; ")} (found, not executed)` : errors.join("; ") });
      }
    }
  }
  return checks;
}

export function renderChecks(checks: Check[]): string[] {
  const mark = { ok: "ok  ", warn: "warn", fail: "FAIL", skip: "-   " };
  return checks.flatMap(c => [`${mark[c.level]} ${c.name}: ${c.detail}`, ...(c.fix && c.level !== "ok" ? [`       fix: ${c.fix}`] : [])]);
}
