import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { dataHome, loadRun } from "./store";

// Finding a run again without its UUID (#8). Everything here is read-only and comes from the
// run records; nothing asks a worker's terminal, so step states are as last recorded.
export interface RunEntry {
  id: string; short: string; name: string; cwds: string[]; createdAt: number; status: string;
  driver: "live" | "none"; open: { step: string; status: string }[];
}
export interface BrokenRun { id: string; error: string }

const FINAL = new Set(["done", "failed", "blocked", "cancelled", "skipped"]);

function runIds(): string[] {
  const dir = join(dataHome(), "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => /^[0-9a-f-]{36}$/.test(name));
}

function driverLive(dir: string): boolean {
  try {
    const pid = Number(readFileSync(join(dir, "driver.lock"), "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    process.kill(pid, 0); return true;
  } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

export function listRuns(): { runs: RunEntry[]; broken: BrokenRun[] } {
  const runs: RunEntry[] = [], broken: BrokenRun[] = [];
  for (const id of runIds()) {
    try {
      const run = loadRun(id);
      runs.push({ id, short: id.slice(0, 8), name: run.workflow.name, cwds: [...new Set(run.workflow.steps.map(s => s.cwd))],
        createdAt: run.createdAt, status: run.status, driver: driverLive(run.dir) ? "live" : "none",
        open: Object.entries(run.steps).filter(([, s]) => !FINAL.has(s.status)).map(([step, s]) => ({ step, status: s.status })) });
    } catch (err) { broken.push({ id, error: (err as Error).message }); }
  }
  runs.sort((a, b) => b.createdAt - a.createdAt);
  return { runs, broken };
}

// Compare real directories (macOS /tmp is /private/tmp, projects may be symlinked); a deleted
// directory falls back to its recorded spelling so its history stays findable (#10).
function canon(path: string): string { try { return realpathSync(path); } catch { return resolve(path); } }

export function filterRuns(runs: RunEntry[], opts: { cwd?: string; status?: string; limit?: number }): RunEntry[] {
  const root = opts.cwd ? canon(opts.cwd) : undefined;
  const under = (c: string) => [c, canon(c)].some(p => p === root || p.startsWith(root + sep));
  return runs.filter(r => (!root || r.cwds.some(under)) && (!opts.status || r.status === opts.status))
    .slice(0, opts.limit ?? 20);
}

// A full UUID, or an unambiguous prefix of at least 4 hex digits. Several matches are listed,
// never guessed between: answer, resume and stop act on whatever this returns.
export function resolveRunId(arg: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(arg)) return arg;
  if (!/^[0-9a-f-]{4,35}$/.test(arg)) throw new Error(`invalid run id: ${arg} (find it with: sflow runs)`);
  const matches = runIds().filter(id => id.startsWith(arg));
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new Error(`no run starts with ${arg} (list them with: sflow runs)`);
  const lines = matches.map(id => { try { const r = loadRun(id); return `  ${id}  ${r.workflow.name}  ${stamp(r.createdAt)}`; } catch { return `  ${id}  (unreadable record)`; } });
  throw new Error(`${arg} matches ${matches.length} runs; use more of the id:\n${lines.join("\n")}`);
}

export function stamp(ms: number): string {
  const d = new Date(ms), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function renderRuns(runs: RunEntry[], broken: BrokenRun[], recorded = runs.length + broken.length): string[] {
  if (!recorded) return ["no runs recorded yet"];
  if (!runs.length && !broken.length) return ["no matching runs (sflow runs without filters lists all of them)"];
  const lines = runs.map(r => {
    const open = r.open.length ? `  open: ${r.open.map(o => `${o.step} ${o.status}`).join(", ")}` : "";
    return `${r.short}  ${stamp(r.createdAt)}  ${r.status}${r.driver === "live" ? " (driver running)" : ""}  ${r.name}  ${r.cwds.join(", ")}${open}`;
  });
  for (const b of broken) lines.push(`${b.id.slice(0, 8)}  unreadable record: ${b.error}`);
  lines.push("states are as recorded; sflow status <id> shows live prompts. Any unambiguous id prefix works.");
  return lines;
}
