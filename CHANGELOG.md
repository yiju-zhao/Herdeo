# Changelog

## [0.2.2](https://github.com/yiju-zhao/Herdeo/compare/v0.2.1...v0.2.2) (2026-10-16)

- fix(doctor): detect native agents bypassing bridge in old shells ([d2c922e](https://github.com/yiju-zhao/Herdeo/commit/d2c922e281a565a21af391422ee6ba1467d54875))

## 0.2.1 (2026-10-15)

### Features

- Share native Codex, Claude Code and Pi sessions between Herdr and Paseo.
- Preserve the original TUI, process and native conversation identity.
- Diagnose CLI, channel, Paseo connection and archive state with `herdeo doctor`.
- Deduplicate Claude/Pi message retries and coalesce streaming snapshots.
- Restore archived Claude/Pi workspaces before reconnecting the original card.
- Preserve native context and history when a removed project requires a new view.
- Build release archives with SHA256 checksums and per-file integrity manifests.
- Automatically version Conventional Commits and publish verified GitHub Release assets.

### Validation

- Automated regression coverage for native PTYs, routing, permissions, history and reconnects.
- Real Codex validation of both launch directions, streaming and typed tool cards.
- Real Pi validation of bidirectional messages, retries, exit history and workspace recovery.
