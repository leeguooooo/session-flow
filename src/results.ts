import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./store";
import type { Run } from "./types";

export function resultFile(run: Run, id: string, hash?: string) { return join(run.dir, ".protocol", `${id}${hash ? `-${hash}` : ""}-result.json`); }
export function storeResult(run: Run, id: string, result: Record<string, unknown>) {
  const body = JSON.stringify(result, null, 2) + "\n", hash = createHash("sha256").update(body).digest("hex");
  const path = resultFile(run, id, hash);
  if (Buffer.byteLength(body) > 128 * 1024) throw new Error("formatted result exceeds 128 KiB; use artifact references");
  mkdirSync(join(run.dir, ".protocol"), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const s = lstatSync(path);
    if (!s.isFile() || s.isSymbolicLink() || s.size > 128 * 1024 || readFileSync(path, "utf8") !== body) throw new Error("immutable result file already contains another report");
  } else atomicWrite(path, result);
  const bytes = readFileSync(path);
  return { status: result.status ?? run.steps[id].status, summary: String(result.summary ?? "").slice(0, 384),
    fullResultFile: path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}
export function resolveResult(run: Run, id: string, value: Record<string, unknown>): Record<string, unknown> {
  if (value.fullResultFile === undefined) return value; // pre-optimization reports remain readable
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) throw new Error("invalid result reference");
  const legacy = run.version === 1 && value.fullResultFile === resultFile(run, id);
  if (!legacy && value.fullResultFile !== resultFile(run, id, value.sha256)) throw new Error("invalid result reference");
  const stat = lstatSync(value.fullResultFile as string);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error("invalid result file");
  const body = readFileSync(value.fullResultFile as string);
  if (createHash("sha256").update(body).digest("hex") !== value.sha256) throw new Error("result hash mismatch");
  const result = JSON.parse(body.toString());
  if (!result || typeof result !== "object" || Array.isArray(result) || result.status !== value.status) throw new Error("result status mismatch");
  return result;
}
