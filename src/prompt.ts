import { createHash } from "node:crypto";

// A selection menu a native TUI is waiting on: folder trust, a tool approval, a login choice.
export interface Menu { id: string; question: string[]; options: string[]; selected: number }

const MARKER = /^(\s*)([❯›>])\s(.*\S)\s*$/;
// Every supported TUI prints a key hint under its menus; an input box ("› Ask Codex…") has none.
const HINT = /\benter\b.{0,12}\b(confirm|continue|select|submit)\b|press enter|navigate|\besc\b.{0,4}\b(cancel|quit|exit)\b/i;

// Reads the visible screen bottom-up and returns the last menu, or null. Options keep the
// TUI's own text, so the user sees exactly what will be chosen.
export function parseMenu(screen: string): Menu | null {
  const lines = screen.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = MARKER.exec(lines[i]);
    if (!m) continue;
    // In a numbered menu every option is numbered, which keeps same-indented question text out.
    const numbered = /^\d+[.)]\s/.test(m[3]);
    const width = m[1].length + 2, sibling = new RegExp(`^${" ".repeat(width)}${numbered ? "\\d+[.)]\\s" : ""}(\\S.*\\S|\\S)\\s*$`);
    // Codex indents its key hint like an option; the hint ends the list. A long option wraps onto
    // deeper-indented lines that belong to it.
    const option = (l: string) => sibling.test(l) && !HINT.test(l);
    const wrapped = (l: string) => /^\s*/.exec(l)![0].length > width && l.trim() !== "" && !HINT.test(l) && !MARKER.test(l);
    const entries: { line: number; text: string }[] = [{ line: i, text: m[3].trim() }];
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (option(lines[j])) { entries.push({ line: j, text: lines[j].trim() }); end = j; }
      else if (wrapped(lines[j])) { entries[entries.length - 1].text += " " + lines[j].trim(); end = j; }
      else break;
    }
    let start = i, carry: string[] = [];
    for (let j = i - 1; j >= 0; j--) {
      if (option(lines[j])) { entries.unshift({ line: j, text: [lines[j].trim(), ...carry].join(" ") }); carry = []; start = j; }
      else if (wrapped(lines[j])) carry.unshift(lines[j].trim());
      else break;
    }
    if (entries.length < 2) continue;
    if (!lines.slice(end + 1, end + 5).some(l => HINT.test(l))) continue;
    const options = entries.map(e => e.text.replace(/^\d+[.)]\s+/, ""));
    const question: string[] = [];
    for (let j = start - 1; j >= 0 && question.length < 12; j--) {
      const text = lines[j].trim();
      if (/^[─━-]{8,}/.test(text)) break;
      if (text || question.length) question.unshift(text);
    }
    while (question.length && !question[0]) question.shift();
    const id = createHash("sha256").update(JSON.stringify([question, options])).digest("hex").slice(0, 8);
    return { id, question, options, selected: entries.findIndex(e => e.line === i) };
  }
  return null;
}

// Arrow keys from the current selection to the choice, then Enter; works for numbered and unnumbered menus.
export function menuKeys(menu: Menu, choice: number): string[] {
  if (!Number.isInteger(choice) || choice < 1 || choice > menu.options.length) throw new Error(`choose 1..${menu.options.length}`);
  const delta = choice - 1 - menu.selected;
  return [...Array(Math.abs(delta)).fill(delta > 0 ? "Down" : "Up"), "Enter"];
}

// After an answer the TUI redraws a moment later; until then the answered menu is still on screen.
// Only a different menu is a follow-up; the same id after the wait is "unchanged", not a new question.
export async function afterAnswer(id: string, read: () => Promise<Menu | null>, tries = 10, waitMs = 300): Promise<Menu | null | "unchanged"> {
  for (let i = 0; i < tries; i++) {
    await Bun.sleep(waitMs);
    const menu = await read();
    if (menu?.id !== id) return menu;
  }
  return "unchanged";
}

// Errors a worker's screen can show before it accepts. Only what is seen is reported; anything
// else is "cause unknown", never assumed to be a trust or approval prompt.
const TROUBLE = /\b(HTTP\s*)?5\d\d\b.*(error|gateway|timeout|unavailable)|\b(error|gateway|timeout)\b.*\b5\d\d\b|rate.?limit|quota|not logged in|log ?in required|please (log|sign) in|sign in to|unauthori[sz]ed|authenticat(e|ion) (failed|required)|api key|connection (refused|reset|error)|network error|ECONNREFUSED|ETIMEDOUT/i;
export function diagnoseScreen(screen: string): string | null {
  const lines = screen.split("\n").map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) if (TROUBLE.test(lines[i])) return lines[i].slice(0, 200);
  return null;
}
