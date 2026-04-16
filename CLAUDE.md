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

## Sprint status

See `sprint-status.yaml` for current epic and phase.

## Ideas and Backlog

The "raw" backlog is kept in `_bmad-output/backlog.md`. Anything to be actually worked MUST be created as formal epic before implementing.
