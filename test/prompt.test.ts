import { test, expect } from "bun:test";
import { parseMenu, menuKeys, diagnoseScreen } from "../src/prompt";

// Screens recorded from real runs (paths shortened).
const claudeTrust = `────────────────────────────────────────────────
 Accessing workspace:

 ~/…/runs/76c780c4/.protocol

 Quick safety check: Is this a project you created or one you trust?

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel`;

const agyApproval = `● Ran 4 commands (1 failed) (ctrl+o to expand)

Command
────────────────────────────────────────────────

Requesting permission for:
   ls -la ~/…/runs/cb12bdf2

Run this command?
> 1. Yes, run command
  2. Yes, and always allow in this conversation for commands that start with 'ls'
  3. Yes, and always allow for commands that start with 'ls' (Persist to settings.json)
  4. No, cancel

  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command
esc to cancel                                   Gemini 3.8 Flash · high`;

const codexIdle = `› Session Flow worker. Run '~/…/double/worker' task once;
  execute only its returned assignment. Stop if it fails.

• Working (8s • esc to interrupt)

› Ask Codex to do anything

  GPT-6.1-Sol medium · ~/…/.protocol`;

const codexTrust = `  Folder access
  ~/…/runs/0f86ecad/implement/worktree
  Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:
  ~/demo1
  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.
› 1. Trust and continue
  2. Quit
  enter continue · esc quit`;

test("reads Codex's folder-trust menu", () => {
  const menu = parseMenu(codexTrust)!;
  expect(menu.options).toEqual(["Trust and continue", "Quit"]);
  expect(menu.question.at(-1)).toContain("Trust this folder?");
  expect(menuKeys(menu, 1)).toEqual(["Enter"]);
});

test("reads Claude's unnumbered folder-trust menu", () => {
  const menu = parseMenu(claudeTrust)!;
  expect(menu.options).toEqual(["No, exit", "Yes, I trust this folder"]);
  expect(menu.selected).toBe(0);
  expect(menu.question[0]).toBe("Accessing workspace:");
  expect(menuKeys(menu, 2)).toEqual(["Down", "Enter"]);
  expect(menuKeys(menu, 1)).toEqual(["Enter"]);
});

test("reads agy's numbered approval menu", () => {
  const menu = parseMenu(agyApproval)!;
  expect(menu.options).toHaveLength(4);
  expect(menu.options[1]).toStartWith("Yes, and always allow in this conversation");
  expect(menu.question).toContain("Run this command?");
  expect(menuKeys(menu, 2)).toEqual(["Down", "Enter"]);
  expect(menuKeys({ ...menu, selected: 3 }, 1)).toEqual(["Up", "Up", "Up", "Enter"]);
  expect(() => menuKeys(menu, 5)).toThrow("choose 1..4");
  expect(() => menuKeys(menu, 0)).toThrow();
});

test("an input box or worker prompt is not a menu", () => {
  expect(parseMenu(codexIdle)).toBeNull();
  expect(parseMenu(claudeTrust.replace("Enter to confirm · Esc to cancel", ""))).toBeNull();
});

test("the prompt id changes when the question or options change", () => {
  const a = parseMenu(agyApproval)!, b = parseMenu(agyApproval.replace("ls -la", "rm -rf"))!;
  expect(a.id).toMatch(/^[0-9a-f]{8}$/);
  expect(parseMenu(agyApproval)!.id).toBe(a.id);
  expect(b.id).not.toBe(a.id);
});

test("screen diagnosis reports only recognised errors", () => {
  expect(diagnoseScreen("thinking...\n  Error: 524 status code (no body)\n> ")).toBe("Error: 524 status code (no body)");
  expect(diagnoseScreen("HTTP 503 Service Unavailable")).toBe("HTTP 503 Service Unavailable");
  expect(diagnoseScreen("Not logged in · Please run /login")).toContain("Not logged in");
  expect(diagnoseScreen("Rate limit reached, retrying in 30s")).toContain("Rate limit");
  expect(diagnoseScreen(codexIdle)).toBeNull();
  expect(diagnoseScreen(claudeTrust)).toBeNull();
  expect(diagnoseScreen("Processed 500 files")).toBeNull();
});

test("a long option that wraps stays one option", () => {
  const screen = ` Bash command
 Rerun tests and edge cases read-only
 This command requires approval
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for sh test.sh, sh greet.sh --shout Ada and sh greet.sh Ada commands
      in ~/.local/state/session-flow/workspaces/claude
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No

 Esc to cancel · Tab to amend`;
  const menu = parseMenu(screen)!;
  expect(menu.options).toHaveLength(4);
  expect(menu.options[1]).toBe("Yes, and don't ask again for sh test.sh, sh greet.sh --shout Ada and sh greet.sh Ada commands in ~/.local/state/session-flow/workspaces/claude");
  expect(menu.options[3]).toBe("No");
  expect(menu.question).toContain("Do you want to proceed?");
  expect(menuKeys(menu, 4)).toEqual(["Down", "Down", "Down", "Enter"]);
});

test("an answered menu still on screen is not reported as the next prompt (#7)", async () => {
  const { afterAnswer } = await import("../src/prompt");
  const old = { id: "a", question: ["q"], options: ["x", "y"], selected: 0 };
  const next = { id: "b", question: ["q2"], options: ["x", "y"], selected: 0 };
  let reads = 0;
  expect(await afterAnswer("a", async () => (++reads < 3 ? old : null), 10, 1)).toBeNull();
  reads = 0;
  expect(await afterAnswer("a", async () => (++reads < 3 ? old : next), 10, 1)).toEqual(next);
  expect(await afterAnswer("a", async () => old, 3, 1)).toBe("unchanged");
});
