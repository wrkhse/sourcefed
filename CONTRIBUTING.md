# Contributing

1. Install Node.js 22+ and a compatible OpenCode release.
2. Run `npm install`.
3. Run `npm run check` before opening a pull request.
4. Keep source-specific behavior inside its source directory.
5. Do not commit `.env`, `.state`, credentials, or real workspace identifiers.

Changes that affect webhook payloads or monitor persistence should include focused
regression tests.

## One-time local setup

Enable this repository's pre-commit hook once per checkout:

    git config core.hooksPath .githooks

On each commit the hook formats only staged files: rustfmt on staged .rs paths (the Rust workspace lives under rust/) and tidy v2.0.0 on the other staged files using the repository's tidy config, then re-stages them. tidy skips file types it does not recognize. A recognized file it cannot parse, a partially staged file, or a tidy download/checksum/platform failure stops the commit with a named reason. It runs no clippy, compile or tests. The tidy pins are plain data in .github/tidy.env; the binary is verified by SHA-256 on first use and the cached archive is verified on every run at `~/.cache/wrkhse/tidy-<sha>/`. CI runs the hook selftest on Ubuntu and macOS.

## Monitors and transports

The abstract `Monitor` consolidates transport fallback and recovery and composes whichever
generic `PollMonitor` and `WebhookMonitor` transports a source exposes as class attributes.
Each provider is its own package (`@sourcefed/provider-{jira,github,slack,yab,schedule,timer}`) with monitor and
event modules; the built-in registry (`SOURCE_MAP`) is composed by the daemon, which imports
the provider packages directly. Jira exposes only polling; GitHub and Slack expose both. Do
not add source-specific transport branches to tools, scheduling, or the daemon.
