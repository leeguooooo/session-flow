import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import SKILL_MD from "../skills/sflow/SKILL.md" with { type: "text" };

export { SKILL_MD };

export function skillPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const pi = env.PI_CODING_AGENT_DIR && isAbsolute(env.PI_CODING_AGENT_DIR) ? env.PI_CODING_AGENT_DIR : join(home, ".pi", "agent");
  return [join(home, ".claude", "skills", "sflow", "SKILL.md"), join(home, ".codex", "skills", "sflow", "SKILL.md"), join(pi, "skills", "sflow", "SKILL.md")];
}

// The skill ships inside the binary so it always matches the installed sflow.
export function installSkill(paths = skillPaths()): string[] {
  for (const path of paths) {
    mkdirSync(dirname(path), { recursive: true });
    try { if (readFileSync(path, "utf8") === SKILL_MD) continue; } catch {}
    // Rename replaces a symlink left by another installer instead of writing through it.
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try { writeFileSync(tmp, SKILL_MD, { flag: "wx", mode: 0o644 }); renameSync(tmp, path); }
    finally { try { unlinkSync(tmp); } catch {} }
  }
  return paths;
}
