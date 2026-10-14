import { createHash } from "node:crypto";

// A selection menu a native TUI is waiting on: folder trust, a tool approval, a login choice.
export interface Menu { id: string; question: string[]; options: string[]; selected: number }

const MARKER = /^(\s*)([❯›>])\s(.*\S)\s*$/;
// Every supported TUI prints a key hint under its menus; an input box ("› Ask Codex…") has none.
const HINT = /enter to confirm|press enter|navigate|esc to cancel/i;

// Reads the visible screen bottom-up and returns the last menu, or null. Options keep the
// TUI's own text, so the user sees exactly what will be chosen.
export function parseMenu(screen: string): Menu | null {
  const lines = screen.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = MARKER.exec(lines[i]);
    if (!m) continue;
    const width = m[1].length + 2, sibling = new RegExp(`^${" ".repeat(width)}(\\S.*\\S|\\S)\\s*$`);
    let start = i, end = i;
    while (start > 0 && sibling.test(lines[start - 1])) start--;
    while (end + 1 < lines.length && sibling.test(lines[end + 1])) end++;
    if (end === start) continue;
    if (!lines.slice(end + 1, end + 5).some(l => HINT.test(l))) continue;
    const options = lines.slice(start, end + 1).map(l => l.replace(MARKER, "$3").trim().replace(/^\d+[.)]\s+/, ""));
    const question: string[] = [];
    for (let j = start - 1; j >= 0 && question.length < 12; j--) {
      const text = lines[j].trim();
      if (/^[─━-]{8,}/.test(text)) break;
      if (text || question.length) question.unshift(text);
    }
    while (question.length && !question[0]) question.shift();
    const id = createHash("sha256").update(JSON.stringify([question, options])).digest("hex").slice(0, 8);
    return { id, question, options, selected: i - start };
  }
  return null;
}

// Arrow keys from the current selection to the choice, then Enter; works for numbered and unnumbered menus.
export function menuKeys(menu: Menu, choice: number): string[] {
  if (!Number.isInteger(choice) || choice < 1 || choice > menu.options.length) throw new Error(`choose 1..${menu.options.length}`);
  const delta = choice - 1 - menu.selected;
  return [...Array(Math.abs(delta)).fill(delta > 0 ? "Down" : "Up"), "Enter"];
}
