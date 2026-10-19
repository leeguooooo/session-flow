# Security policy

Security fixes target the latest released version. Upgrade before checking whether a report still reproduces.

## Reporting a vulnerability

Email leeguoooo@gmail.com with the affected version, platform, reproduction steps and expected impact. Do not publish credentials, personal data or exploit details in a public issue. Prefer a minimal reproduction using synthetic data. We will assess the report and coordinate fixes and disclosure; there is no guaranteed response time or bounty program.

## Boundaries

sflow starts agent sessions and sends them the prompts in a workflow file, so only run workflows you have read. Each step runs with that agent's own permissions; sflow passes trust and approval prompts to you and does not answer them on its own. Results passed between steps are untrusted input for the next agent. sflow does not commit or push on its own.
