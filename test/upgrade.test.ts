import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectSkills, fetchLatest, maybeNotice, newer, noticeDisabled, runUpdateCheck, upgrade } from "../src/upgrade";

let tag: unknown = "v0.2.0", status = 200, auth = "";
const server = Bun.serve({ port: 0, fetch(req) { auth = req.headers.get("authorization") ?? ""; return Response.json({ tag_name: tag }, { status }); } });
afterAll(() => server.stop(true));
const url = `http://127.0.0.1:${server.port}/latest`;

test("versions compare numerically", () => {
  expect(newer("0.1.10", "0.1.9")).toBe(true);
  expect(newer("0.1.6", "0.1.6")).toBe(false);
  expect(newer("0.1.5", "0.1.6")).toBe(false);
  expect(newer("junk", "0.1.6")).toBe(false);
});

test("latest release lookup never throws and honours GITHUB_TOKEN", async () => {
  tag = "v0.2.0"; status = 200;
  expect(await fetchLatest({ SFLOW_UPGRADE_LATEST_URL: url, GITHUB_TOKEN: "t0k" })).toEqual({ version: "0.2.0" });
  expect(auth).toBe("Bearer t0k");
  status = 403;
  expect(await fetchLatest({ SFLOW_UPGRADE_LATEST_URL: url })).toEqual({ error: "HTTP 403" });
  status = 200; tag = 7;
  expect("error" in await fetchLatest({ SFLOW_UPGRADE_LATEST_URL: url })).toBe(true);
  expect("error" in await fetchLatest({ SFLOW_UPGRADE_LATEST_URL: "http://127.0.0.1:1/x" })).toBe(true);
});

test("the release page redirect names the latest version without the API, which stays the fallback", async () => {
  let location = "https://github.com/x/y/releases/tag/v0.3.1", pageHits = 0;
  const page = Bun.serve({ port: 0, fetch() { pageHits++; return new Response(null, { status: location ? 302 : 404, headers: location ? { location } : {} }); } });
  try {
    const pageUrl = `http://127.0.0.1:${page.port}/releases/latest`;
    tag = "v0.2.0"; status = 403;
    expect(await fetchLatest({ SFLOW_UPGRADE_PAGE_URL: pageUrl, SFLOW_UPGRADE_LATEST_URL: url })).toEqual({ version: "0.3.1" });
    location = ""; status = 200;
    expect(await fetchLatest({ SFLOW_UPGRADE_PAGE_URL: pageUrl, SFLOW_UPGRADE_LATEST_URL: url })).toEqual({ version: "0.2.0" });
    status = 403;
    expect(await fetchLatest({ SFLOW_UPGRADE_PAGE_URL: pageUrl, SFLOW_UPGRADE_LATEST_URL: url })).toEqual({ error: "release page: HTTP 404 without a release redirect; API: HTTP 403" });
    location = "https://github.com/x/y/releases/tag/nightly";
    expect("error" in await fetchLatest({ SFLOW_UPGRADE_PAGE_URL: pageUrl, SFLOW_UPGRADE_LATEST_URL: url })).toBe(true);
    expect(pageHits).toBe(4);
  } finally { page.stop(true); status = 200; tag = "v0.2.0"; }
});

test("upgrade runs the installer only when a newer release exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-upgrade-")), marker = join(dir, "ran");
  const installer = join(dir, "install.sh"); writeFileSync(installer, `echo ran > ${marker}
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\necho %s\\n' "$SFLOW_VERSION" > "$HOME/.local/bin/sflow"
chmod 755 "$HOME/.local/bin/sflow"
`);
  const env = { SFLOW_UPGRADE_LATEST_URL: url, SFLOW_UPGRADE_INSTALLER: installer, HOME: dir };
  try {
    tag = "v0.1.6"; status = 200;
    expect(await upgrade("0.1.6", "install", env)).toBe(0);
    expect(existsSync(marker)).toBe(false);
    tag = "v0.2.0";
    expect(await upgrade("0.1.6", "check", env)).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(await upgrade("0.1.6", "install", env)).toBe(0);
    expect(existsSync(marker)).toBe(true);
    writeFileSync(installer, "exit 3\n");
    expect(await upgrade("0.1.6", "install", env)).toBe(2);
    status = 500;
    expect(await upgrade("0.1.6", "check", env)).toBe(2);
    expect(await upgrade("0.1.6", "json", env)).toBe(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skill copies are found with how to refresh them", () => {
  const home = mkdtempSync(join(tmpdir(), "sf-upgrade-"));
  try {
    mkdirSync(join(home, ".claude/plugins"), { recursive: true });
    writeFileSync(join(home, ".claude/plugins/installed_plugins.json"), `{"plugins":{"sflow@leeguooooo-plugins":[]}}`);
    for (const d of [".claude/skills/sflow", ".agents/skills/sflow"]) { mkdirSync(join(home, d), { recursive: true }); writeFileSync(join(home, d, "SKILL.md"), "x"); }
    const found = detectSkills({}, home);
    expect(found.map(f => f.channel).sort()).toEqual(["claude-plugin", "copied", "installer"]);
    expect(found.find(f => f.channel === "installer")!.update).toBe("sflow skill install");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("daily notice goes to stderr from the cache and stays quiet where it should", async () => {
  const cache = mkdtempSync(join(tmpdir(), "sf-upgrade-"));
  try {
    for (const env of [{ CI: "1" }, { SFLOW_NO_UPDATE_CHECK: "1" }, { USE_NO_UPDATE_CHECK: "1" }]) expect(noticeDisabled(env, "status")).toBe(true);
    for (const cmd of ["upgrade", "version", "--help", "task", "report", "_update-check", undefined]) expect(noticeDisabled({}, cmd)).toBe(true);
    expect(noticeDisabled({}, "status")).toBe(false);

    tag = "v0.3.0"; status = 200;
    const env = { XDG_CACHE_HOME: cache, SFLOW_UPGRADE_LATEST_URL: url };
    await runUpdateCheck(env);
    const file = join(cache, "sflow/update-check.json");
    expect(JSON.parse(readFileSync(file, "utf8")).latest).toBe("0.3.0");
    status = 500; await runUpdateCheck(env);
    expect(JSON.parse(readFileSync(file, "utf8")).latest).toBe("0.3.0");

    const lines: string[] = [], write = process.stderr.write;
    process.stderr.write = ((s: string) => { lines.push(s); return true; }) as typeof process.stderr.write;
    try {
      maybeNotice("0.1.6", "status", ["/bin/false"], env);
      maybeNotice("0.3.0", "status", ["/bin/false"], env);
      maybeNotice("0.1.6", "task", ["/bin/false"], env);
    } finally { process.stderr.write = write; }
    expect(lines).toEqual(["sflow 0.3.0 is available (you have 0.1.6). Upgrade: sflow upgrade\n"]);
  } finally { rmSync(cache, { recursive: true, force: true }); }
});

test("local upgrade blockers preserve unresolved jobs and team sessions", () => {
  const { localUpgradeBlockers } = require("../src/upgrade") as typeof import("../src/upgrade");
  const dir = mkdtempSync(join(tmpdir(), "sf-upgrade-state-"));
  try {
    for (const path of ["runs/a", "teams/t"]) mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(join(dir, "runs/a/run.json"), JSON.stringify({ status: "blocked", steps: {} }));
    writeFileSync(join(dir, "teams/t/team.json"), JSON.stringify({ members: { rev: { status: "uncertain" } } }));
    expect(localUpgradeBlockers({ SFLOW_HOME: dir })).toEqual(["run a (blocked)", "team t"]);
    writeFileSync(join(dir, "runs/a/run.json"), JSON.stringify({ status: "done", steps: {} }));
    writeFileSync(join(dir, "teams/t/team.json"), JSON.stringify({ members: { rev: { status: "closed" } } }));
    expect(localUpgradeBlockers({ SFLOW_HOME: dir })).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("coordinated upgrade delegates hosts to the verified new binary and reports partial failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-upgrade-handoff-")), marker = join(dir, "called");
  const installer = join(dir, "install.sh");
  try {
    const env = { SFLOW_UPGRADE_LATEST_URL: url, SFLOW_UPGRADE_INSTALLER: installer, HOME: dir, PATH: process.env.PATH };
    tag = "v0.8.0"; status = 200;
    writeFileSync(installer, `mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/sflow" <<'SH'
#!/bin/sh
case "$1" in version) echo 0.8.0;; hosts) echo "$*" > '${marker}'; exit 2;; esac
SH
chmod 755 "$HOME/.local/bin/sflow"
`);
    expect(await upgrade("0.7.1", "install", env, true)).toBe(2);
    expect(readFileSync(marker, "utf8").trim()).toBe("hosts upgrade");
    rmSync(marker);
    writeFileSync(installer, "exit 1\n");
    expect(await upgrade("0.7.1", "install", env, true)).toBe(2);
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
