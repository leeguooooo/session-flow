# Catalog scan review (2026-10-19)

Source revision: `4876e4d85bd941bf0f1bd3784c352a3f8ccf0517`. With plugin-scanner 3.0.123, the local score was 65 before these changes and 87 after. These are local preflight results; listing still requires the catalog's own centralized score of at least 80.

## Changes

Actions in `ci.yml` and `release.yml` are pinned to immutable SHAs. A vulnerability reporting policy and Dependabot are added, and a read-only, offline source scan runs on pushes and pull requests using the catalog's exact action SHA and score threshold. No scanner suppressions or baseline are configured, and no runtime code changed.

## Remaining findings

Every remaining `HARDCODED_SECRET` location is a synthetic test fixture or a documented development-only placeholder, not a live credential:

| Rule | Severity | Location | What it is |
| --- | --- | --- | --- |
| `HARDCODED_SECRET` | high | `test/hosts.test.ts:376` | step `token: "synthetic"` in a test run fixture |

## Reproduction

```sh
# In an isolated Python environment:
python -m pip install plugin-scanner==3.0.123
plugin-scanner scan . --format json --output /tmp/scan.json --min-score 80 --fail-on-severity none
```
