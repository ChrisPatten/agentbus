# Versioning

AgentBus uses [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`).

- **MAJOR** — incompatible/breaking changes (config schema breaks, DB migration
  that isn't backward compatible, removed HTTP/MCP surface).
- **MINOR** — backward-compatible features (new adapter, new tool, new endpoint).
- **PATCH** — backward-compatible bug fixes only.

## Single source of truth

`package.json` `version` is authoritative. Runtime code reads it via
`src/version.ts` (exported `VERSION`), which `/api/v1/health` reports. Never
hardcode a version string elsewhere — import `VERSION` instead.

## Cutting a release

1. **Update the changelog.** Move the relevant items from `## [Unreleased]` in
   [CHANGELOG.md](../CHANGELOG.md) into a new `## [x.y.z] - YYYY-MM-DD` section,
   and update the compare links at the bottom. Commit it.
2. **Review the homepage.** If this release changes the pitch, feature list,
   or quick start steps, update `site/index.html` to match and commit it
   alongside the changelog. Version/license/last-commit badges on the page
   are live shields.io badges — they update automatically and need no edits.
   See [GITHUB_PAGES.md](GITHUB_PAGES.md).
3. **Run the release script** for the bump type. This runs the test suite
   (`preversion`), bumps `package.json`, commits, and creates an annotated git
   tag `vX.Y.Z`:

   ```bash
   npm run release:patch   # 0.1.0 -> 0.1.1
   npm run release:minor   # 0.1.0 -> 0.2.0
   npm run release:major   # 0.1.0 -> 1.0.0
   ```

4. **Push** the commit and the tag:

   ```bash
   git push && git push --tags
   ```

## Notes

- `preversion` runs `vitest run`; a failing suite aborts the release before
  anything is bumped or tagged.
- `npm version` refuses to run with a dirty working tree — commit the changelog
  (step 1) first.
- Pre-1.0.0 (`0.y.z`): minor bumps may carry breaking changes per SemVer's
  initial-development clause; call those out clearly in the changelog.
