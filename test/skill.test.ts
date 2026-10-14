import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SKILL_MD, installSkill, skillPaths } from "../src/skill";

test("skill installs for Claude Code, Codex, Pi and agy", () => {
  const home = mkdtempSync(join(tmpdir(), "sf-skill-"));
  try {
    expect(SKILL_MD).toStartWith("---\nname: sflow\n");
    const paths = skillPaths({}, home);
    expect(paths).toEqual([join(home, ".claude/skills/sflow/SKILL.md"), join(home, ".codex/skills/sflow/SKILL.md"), join(home, ".pi/agent/skills/sflow/SKILL.md"), join(home, ".gemini/config/skills/sflow/SKILL.md")]);
    expect(skillPaths({ PI_CODING_AGENT_DIR: join(home, "pi") }, home)[2]).toBe(join(home, "pi/skills/sflow/SKILL.md"));
    // An outdated copy reached through a symlink is replaced without touching the link's target.
    const shared = join(home, "shared.md"); writeFileSync(shared, "old");
    mkdirSync(join(home, ".codex/skills/sflow"), { recursive: true }); symlinkSync(shared, paths[1]);
    installSkill(paths); installSkill(paths);
    for (const p of paths) expect(readFileSync(p, "utf8")).toBe(SKILL_MD);
    expect(lstatSync(paths[1]).isSymbolicLink()).toBe(false);
    expect(readFileSync(shared, "utf8")).toBe("old");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
