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
