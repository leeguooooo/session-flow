import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OcsTransport } from "../src/ocs";

test("Codex actor uses full native thread id even when discovery omits self", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-identity-")), bin = join(dir, "ocs");
  const old = process.env.CODEX_THREAD_ID;
  writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "whoami" ]; then printf \'{"id":"codex-11111111"}\\n\'; else printf \'{"entries":[]}\\n\'; fi\n'); chmodSync(bin, 0o700);
  try {
    process.env.CODEX_THREAD_ID = "11111111-2222-4333-8444-555555555555";
    expect(await new OcsTransport(bin).whoami()).toBe("codex-11111111-2222-4333-8444-555555555555");
    process.env.CODEX_THREAD_ID = "11111111-6666-4333-8444-555555555555";
    expect(await new OcsTransport(bin).whoami()).toBe("codex-11111111-6666-4333-8444-555555555555");
    delete process.env.CODEX_THREAD_ID;
    await expect(new OcsTransport(bin).whoami()).rejects.toThrow("full native");
  } finally { if (old === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = old; rmSync(dir, { recursive: true, force: true }); }
});

test("Pi actor uses the full session id from the OCS Pi extension; agy is bound to its step", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-identity-")), bin = join(dir, "ocs");
  const old = process.env.OCS_PI_SESSION_ID;
  writeFileSync(bin, '#!/bin/sh\nprintf \'{"host":"pi","id":"pi-01a1386a"}\\n\'\n'); chmodSync(bin, 0o700);
  try {
    process.env.OCS_PI_SESSION_ID = "01a1386a-5b57-72eb-9178-7f54f0dd7686";
    expect(await new OcsTransport(bin).whoami("pi")).toBe("pi-01a1386a-5b57-72eb-9178-7f54f0dd7686");
    await expect(new OcsTransport(bin).whoami("claude")).rejects.toThrow("this step runs on claude");
    process.env.OCS_PI_SESSION_ID = "99999999-5b57-72eb-9178-7f54f0dd7686";
    await expect(new OcsTransport(bin).whoami("pi")).rejects.toThrow("ocs doctor --fix");
    delete process.env.OCS_PI_SESSION_ID;
    await expect(new OcsTransport(bin).whoami("pi")).rejects.toThrow("full Pi session identity");
    expect(await new OcsTransport(join(dir, "missing")).whoami("agy", { runId: "cb12bdf2-b686", stepId: "double" })).toBe("agy-cb12bdf2-double");
  } finally { if (old === undefined) delete process.env.OCS_PI_SESSION_ID; else process.env.OCS_PI_SESSION_ID = old; rmSync(dir, { recursive: true, force: true }); }
});
