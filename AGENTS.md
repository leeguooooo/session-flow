# Session Flow

Independent workflow layer over the public OCS CLI. Do not import or copy OCS internals.
Read DESIGN.md before changing lifecycle or recovery.

Validation: `bun test`, `bun run check`, `bun run build`.
Never treat idle, process exit, a send receipt, or a local dispatched flag as completion.
Never automatically resend an uncertain assignment or recreate an uncertain worker.
Only manage tmux sessions on the private socket recorded for this run.
Do not alter global Claude/Codex permissions. Do not add bypass flags.
GitHub Release binaries and checksums are the distribution channel, not npm.
Use synthetic fixtures for tests; keep real workflow records out of git.
