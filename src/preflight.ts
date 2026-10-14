import { command } from "./process";

export interface Tool { name: string; binary: string; versionArgs: string[]; hint: string }

const OCS_INSTALL = "curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | sh";

export function requiredTools(tmux: string, ocs: string, agents: Iterable<string>): Tool[] {
  const tools: Tool[] = [
    { name: "tmux", binary: tmux, versionArgs: ["-V"],
      hint: "each step runs in a private tmux session. Install it with `brew install tmux` (macOS) or `sudo apt install tmux` (Debian/Ubuntu), or point SFLOW_TMUX_BIN at an existing binary" },
    { name: "ocs", binary: ocs, versionArgs: ["version"],
      hint: `assignments and results travel over OCS 0.8.0 or newer. Install it with \`${OCS_INSTALL}\`, or point SFLOW_OCS_BIN at an existing binary` },
  ];
  for (const agent of new Set(agents)) tools.push({ name: agent, binary: agent, versionArgs: ["--version"],
    hint: `a step in this workflow uses ${agent}. Install the ${agent} CLI and sign in once interactively` });
  return tools;
}

// Checks every tool before anything is created, so one run reports all missing dependencies together.
export async function preflight(tools: Tool[]): Promise<void> {
  const problems: string[] = [];
  for (const tool of tools) {
    if (!Bun.which(tool.binary)) { problems.push(`${tool.name} not found (${tool.binary}): ${tool.hint}`); continue; }
    const r = await command([tool.binary, ...tool.versionArgs]).catch((e: Error) => ({ code: 1, stdout: "", stderr: e.message }));
    if (r.code) problems.push(`${tool.name} is installed but \`${tool.binary} ${tool.versionArgs.join(" ")}\` failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
  }
  if (problems.length) throw new Error(`cannot start; nothing was created:\n${problems.map(p => `  - ${p}`).join("\n")}`);
}
