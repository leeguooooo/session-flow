import { parseBody } from "./engine";
import { validProof } from "./protocol";
import type { Message, Run, WorkerEvent } from "./types";

export function runMetrics(run: Run, rows: Message[]) {
  let assignments = 0, acceptances = 0, results = 0, protocolBytes = 0;
  for (const row of rows) {
    const e = parseBody(row) as any;
    if (!e || e.runId !== run.id) continue;
    if (e.type === "sflow.task" && row.from === `sflow-${run.id}`) { assignments++; protocolBytes += Buffer.byteLength(row.body); }
    if (e.type === "sflow.worker" && row.from === e.actor && run.steps[e.stepId] && validProof(e as WorkerEvent, run.steps[e.stepId].token)) {
      if (e.status === "accepted") acceptances++; else if (["done", "failed", "blocked"].includes(e.status)) results++;
      protocolBytes += Buffer.byteLength(row.body);
    }
  }
  return { assignments, acceptances, results, otherMessages: rows.length - assignments - acceptances - results,
    protocolBytes, protocolWakeRequests: 0,
    taskContextBytes: Object.values(run.steps).reduce((n, s) => n + (s.contextBytes ?? 0), 0),
    dependencyContextBytes: Object.values(run.steps).reduce((n, s) => n + (s.dependencyBytes ?? 0), 0),
    fullDependencyBytes: Object.values(run.steps).reduce((n, s) => n + (s.fullDependencyBytes ?? 0), 0),
    units: "bytes and messages, not model tokens or verified cache hits" };
}
