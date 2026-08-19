# AgentBus

## Commands

```bash
# Run
npx tsx src/index.ts            # Run bus core
npx tsx src/adapters/cc.ts      # Run Claude Code adapter

# Test & type-check
npx vitest run                  # Run all tests
npx vitest run src/path/to.test.ts  # Run a single test file
npx tsc --noEmit                # Type-check without building

# Build
npm run build                   # Compile to dist/
```

## Testing policy

Only run the full suite (`npx vitest run`) after changes to application code (anything under `src/` that isn't a `*.test.ts` file). Skip it for:
- Documentation-only changes (`docs/`, `CLAUDE.md`, `README.md`, etc.)
- Changes that only add or modify test files, with no application code touched

For those cases, `npx tsc --noEmit` (if `.ts` files changed) is sufficient — application behavior hasn't changed, so there's no need to re-run the full suite.

## TypeScript / ESM

This project uses `"module": "NodeNext"`. All imports between `.ts` files **must** use `.js` extensions, not `.ts`:

```ts
// correct
import { foo } from './foo.js';

// wrong — will fail at runtime
import { foo } from './foo';
```

## Documentation requirement

**Every implementation change must include a corresponding update to `docs/`.** Create or update the relevant doc file(s) in the same change. Do not mark a task complete without updating docs.

## Versioning

This project uses Semantic Versioning. `package.json` `version` is the single source of truth (read at runtime via `src/version.ts`); git tags are `vX.Y.Z`. See `docs/VERSIONING.md` for the full process and `CHANGELOG.md` for history.

**While working:** add a bullet under `## [Unreleased]` in `CHANGELOG.md` describing user-facing changes (Added / Changed / Fixed / Removed). Do **not** bump `package.json` or create tags as part of normal work.

**As a pre-merge step:** before a branch merges, propose the next version with a rationale based on the `[Unreleased]` entries:
- **MAJOR** — breaking change (config schema break, non-backward-compatible migration, removed HTTP/MCP surface)
- **MINOR** — backward-compatible feature (new adapter, tool, or endpoint)
- **PATCH** — backward-compatible bug fixes only
- Pre-1.0.0: a minor bump may carry breaking changes — say so explicitly.

**Always confirm the proposed version with the user before incrementing.** Never bump `package.json` or create a tag without explicit approval.

Once approved, the release is split across the merge so the tag lands on `main`:
1. **In the feature branch (pre-merge):** move the `[Unreleased]` items under a dated `## [x.y.z]` heading and update the compare links in `CHANGELOG.md`. Commit this with the rest of the branch. **Do not** run `npm version` here — tagging the branch strands the tag on a commit that a squash-merge discards.
2. **On `main` (post-merge):** run `npm run release:patch|minor|major` (test-gated; bumps `package.json`, commits, tags `vX.Y.Z`), then `git push --tags`. This points the tag at a commit that is part of `main`'s history.

## Sprint status

See `sprint-status.yaml` for current epic and phase.

## Ideas and Backlog

The "raw" backlog is kept in `_bmad-output/backlog.md`. Anything to be actually worked MUST be created as formal epic before implementing.
