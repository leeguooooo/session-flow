import { spawn } from "node:child_process";
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (["CLAUDECODE", "TMUX", "TMUX_PANE"].includes(key) || /^(CLAUDE_CODE_|CODEX_THREAD|CODEX_SESSION|HERMES_SESSION|PI_SESSION|OCS_NAME|SFLOW_)/.test(key)) delete env[key];
  }
  // Credentials and provider configuration remain with the user's native CLIs.
  return { ...env, ...extra };
}
export async function command(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${args[0]} timed out; outcome may be unknown`)); }, options.timeoutMs ?? 15000);
    child.stdout.on("data", d => { stdout += d; if (stdout.length > 4 * 1024 * 1024) child.kill(); });
    child.stderr.on("data", d => { stderr += d; });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}
export async function checked(args: string[], options: Parameters<typeof command>[1] = {}) {
  const r = await command(args, options);
  if (r.code) throw new Error(`${args[0]} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}
export function quote(s: string): string { return "'" + s.replaceAll("'", "'\\''") + "'"; }
