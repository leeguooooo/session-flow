import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { candidates, hostsFile, loadHosts, parseHost, saveHosts, sshBinary, sshOptions, SshLink, unfit, REMOTE_PROTOCOL, DEFAULTS, type Hello } from "./hosts";
import type { HostRouter } from "./hostrun";
import type { HostConfig, Workflow } from "./types";

// The hosts a workflow names, copied into the run so a resume never reads a changed file.
export function freezeHosts(workflow: Workflow): Record<string, HostConfig> | undefined {
  const named = workflow.steps.filter(s => s.host);
  if (!named.length) return undefined;
  const all = loadHosts(), out: Record<string, HostConfig> = {};
  for (const s of named) for (const n of candidates(s.host!, all)) out[n] = all[n];
  return out;
}
async function hello(name: string, config: HostConfig): Promise<{ hello?: Hello; error?: string }> {
  try { return { hello: await new SshLink(name, config).call<Hello>("hello", {}, 20_000) }; } catch (e) { return { error: (e as Error).message }; }
}
// Before a run exists: every host answers, speaks this protocol, and each step has a host with its tools.
export async function hostPreflight(workflow: Workflow, hosts?: Record<string, HostConfig>) {
  if (!hosts) return;
  const seen: Record<string, { hello?: Hello; error?: string }> = {};
  for (const [n, c] of Object.entries(hosts)) seen[n] = await hello(n, c);
  const problems: string[] = [];
  for (const s of workflow.steps.filter(s => s.host)) {
    const needs = ["git", ...(s.agent === "command" ? [] : ["tmux", "ocs", s.agent])];
    const why: string[] = [];
    const ok = candidates(s.host!, hosts).filter(n => {
      const h = seen[n];
      if (!h.hello) { why.push(h.error!); return false; }
      if (h.hello.protocol !== REMOTE_PROTOCOL) { why.push(unfit(n, hosts[n], h.hello)!); return false; }
      const missing = needs.filter(t => !h.hello!.tools[t]);
      if (missing.length) { why.push(`${n} lacks ${missing.join(", ")}`); return false; }
      return true;
    });
    if (!ok.length) problems.push(`${s.id}: no usable host (${[...new Set(why)].join("; ")})`);
  }
  if (problems.length) throw new Error(`cannot start; nothing was created:\n${problems.map(p => `  - ${p}`).join("\n")}\n  check them with: sflow hosts check`);
}

function flag(list: string[], name: string): string | undefined {
  const i = list.indexOf(name);
  if (i < 0) return undefined;
  const v = list[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
  list.splice(i, 2); return v;
}
function run(argv: string[]): Promise<number> {
  return new Promise((res, rej) => { const c = spawn(argv[0], argv.slice(1), { stdio: "inherit" }); c.on("error", rej); c.on("exit", code => res(code ?? 1)); });
}
const USAGE = `sflow hosts list [--json]
sflow hosts add <name> --ssh <user@host|ssh alias> [--bin path] [--slots n] [--max-load per-core] [--min-free-gb n] [--site s] [--tag t]...
sflow hosts remove <name>
sflow hosts check [name...] [--json]      reach each host over ssh: sflow version, tools, load, disk, slots
sflow hosts install <name> [--from <sflow binary>]   install sflow there (the release installer, or copy a binary)
sflow hosts gc [name...] [--days n]       delete finished command jobs older than n days (default 7) on those hosts

A step runs on a host with "host": "<name>" (or a list, or "any"); "agent": "command" with
"command": [argv] runs a build or test there. Hosts need non-interactive ssh (BatchMode) from here.
Defaults: bin ${DEFAULTS.bin}, slots ${DEFAULTS.slots}, max-load ${DEFAULTS.maxLoad} per core, min-free-gb ${DEFAULTS.minFreeGB}.`;

export async function hostsCommand(args: string[], _router: HostRouter): Promise<number> {
  const [sub, ...rest] = args;
  const json = rest.includes("--json"), list = rest.filter(a => a !== "--json");
  if (!sub || sub === "help" || sub === "--help") { console.log(USAGE); return 0; }
  if (sub === "list") {
    const hosts = loadHosts();
    if (json) console.log(JSON.stringify({ file: hostsFile(), hosts }, null, 2));
    else if (!Object.keys(hosts).length) console.log(`no hosts yet (${hostsFile()}); add one with: sflow hosts add <name> --ssh <target>`);
    else for (const [n, h] of Object.entries(hosts)) console.log(`${n}  ${h.ssh}  slots ${h.slots}, max-load ${h.maxLoad}/core, min-free ${h.minFreeGB} GB${h.site ? `, site ${h.site}` : ""}${h.tags?.length ? `, tags ${h.tags.join(",")}` : ""}`);
    return 0;
  }
  if (sub === "add") {
    const name = list.shift();
    if (!name) throw new Error("hosts add <name> --ssh <target>");
    const tags: string[] = [];
    for (let t = flag(list, "--tag"); t; t = flag(list, "--tag")) tags.push(t);
    const num = (f: string) => { const v = flag(list, f); return v === undefined ? undefined : Number(v); };
    const raw = { ssh: flag(list, "--ssh"), bin: flag(list, "--bin"), slots: num("--slots"), maxLoad: num("--max-load"), minFreeGB: num("--min-free-gb"),
      site: flag(list, "--site"), ...(tags.length ? { tags } : {}) };
    if (list.length) throw new Error(`unexpected arguments: ${list.join(" ")}`);
    const hosts = loadHosts();
    hosts[name] = parseHost(name, Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)));
    saveHosts(hosts);
    console.log(`saved ${name} in ${hostsFile()}; check it with: sflow hosts check ${name}`); return 0;
  }
  if (sub === "remove") {
    const hosts = loadHosts();
    if (!list[0] || !hosts[list[0]]) throw new Error("hosts remove <name>");
    delete hosts[list[0]]; saveHosts(hosts); console.log(`removed ${list[0]}`); return 0;
  }
  if (sub === "check") {
    const hosts = loadHosts(), names = list.length ? list : Object.keys(hosts);
    if (!names.length) { console.log(`no hosts in ${hostsFile()}`); return 1; }
    let bad = 0; const out: Record<string, unknown> = {};
    for (const n of names) {
      if (!hosts[n]) throw new Error(`unknown host ${n}`);
      const h = await hello(n, hosts[n]);
      const why = h.hello ? unfit(n, hosts[n], h.hello) : h.error;
      if (h.error || (h.hello && h.hello.protocol !== REMOTE_PROTOCOL)) bad++;
      out[n] = { ...h, ...(why ? { problem: why } : {}) };
      if (json) continue;
      if (!h.hello) { console.log(`✗ ${n} (${hosts[n].ssh}): ${h.error}\n    install sflow there with: sflow hosts install ${n}`); continue; }
      const x = h.hello, tools = Object.entries(x.tools).map(([k, v]) => v ? k : `no ${k}`).join(", ");
      console.log(`${why ? "!" : "✓"} ${n} (${hosts[n].ssh}): sflow ${x.version}, ${x.platform}/${x.arch}, ${x.cpus} cores, load ${x.load.toFixed(1)}, ${x.freeGB.toFixed(1)} GB free`);
      console.log(`    ${tools}`);
      if (x.slots.length) console.log(`    slots in use: ${x.slots.map(s => s.owner || "(claiming)").join(", ")}`);
      if (why) console.log(`    ${why}`);
    }
    if (json) console.log(JSON.stringify(out, null, 2));
    return bad ? 1 : 0;
  }
  if (sub === "gc") {
    const days = Number(flag(list, "--days") ?? 7), hosts = loadHosts();
    let bad = 0;
    for (const n of list.length ? list : Object.keys(hosts)) {
      if (!hosts[n]) throw new Error(`unknown host ${n}`);
      try { const r = await new SshLink(n, hosts[n]).call<{ removed: string[] }>("gc", { days }, 600_000); console.log(`${n}: removed ${r.removed.length} job(s)`); }
      catch (e) { bad++; console.log(`${n}: ${(e as Error).message}`); }
    }
    return bad ? 1 : 0;
  }
  if (sub === "install") {
    const name = list.shift(), from = flag(list, "--from"), hosts = loadHosts();
    if (!name || !hosts[name]) throw new Error("hosts install <name> [--from <binary>]");
    const h = hosts[name], ssh = [sshBinary(), ...sshOptions(), h.ssh];
    if (h.bin !== DEFAULTS.bin) throw new Error(`${name} uses bin ${h.bin}; install there yourself`);
    if (from) {
      if (!existsSync(from)) throw new Error(`${from} not found`);
      const scp = process.env.SFLOW_SCP_BIN ?? "scp";
      let code = await run([...ssh, "mkdir -p \"$HOME/.local/bin\""]);
      if (!code) code = await run([scp, "-q", ...sshOptions(), from, `${h.ssh}:.local/bin/sflow.new`]);
      if (!code) code = await run([...ssh, "chmod 755 \"$HOME/.local/bin/sflow.new\" && mv \"$HOME/.local/bin/sflow.new\" \"$HOME/.local/bin/sflow\" && \"$HOME/.local/bin/sflow\" version"]);
      return code;
    }
    return run([...ssh, "curl -fsSL https://raw.githubusercontent.com/leeguooooo/session-flow/main/install.sh | SFLOW_INSTALL_SKILLS=0 sh"]);
  }
  throw new Error(`unknown hosts command ${sub}\n${USAGE}`);
}
