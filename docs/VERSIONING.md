# Versioning

AgentBus uses [Semantic Versioning](https://semver.org/).

| Bump | When |
|---|---|
| MAJOR | Breaking change: config schema break, non-backward-compatible migration, removed HTTP or MCP surface |
| MINOR | Backward-compatible feature: new adapter, tool, endpoint, or config option |
| PATCH | Backward-compatible bug fixes only |

Before 1.0.0 a minor bump may carry a breaking change. Say so explicitly in the changelog.

## Source of truth

`package.json` `version` is authoritative. `src/version.ts` exports it as `VERSION`, which `GET /api/v1/health` reports. Never hardcode a version string elsewhere.

## While working

Add a bullet under `## [Unreleased]` in `CHANGELOG.md` for every user-facing change (Added, Changed, Fixed, Removed). Do not bump `package.json` or create tags on a feature branch.

## Cutting a release

The tag must land on `main`, so the release is split across the merge.

1. **On the feature branch, before merging.** Propose the next version and its rationale from the `[Unreleased]` entries and get it confirmed. Move those entries under a dated `## [x.y.z] - YYYY-MM-DD` heading and update the compare links at the bottom of `CHANGELOG.md`. If the release changes the pitch, feature list, or quick start, update `site/index.html` too ([GITHUB_PAGES.md](GITHUB_PAGES.md)). Commit with the branch. Do not run `npm version` here; a squash merge would strand the tag.
2. **On `main`, after merging.** Run the release script for the bump type. It runs the test suite (`preversion`), bumps `package.json`, commits, and creates the annotated tag `vX.Y.Z`:

   ```bash
   npm run release:patch   # 0.11.0 -> 0.11.1
   npm run release:minor   # 0.11.0 -> 0.12.0
   npm run release:major   # 0.11.0 -> 1.0.0
   ```

3. Push the commit and the tag:

   ```bash
   git push && git push --tags
   ```

`npm version` refuses to run with a dirty working tree, and a failing test suite aborts the release before anything is bumped.
