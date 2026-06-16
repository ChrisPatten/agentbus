/**
 * Single source of truth for the application version.
 *
 * Reads `version` from package.json so it never drifts from the npm metadata
 * or the git tags created by `npm version`. The relative URL resolves to the
 * repo root from both `src/version.ts` (run via tsx) and `dist/version.js`
 * (compiled), since both live one level below the project root.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };

export const VERSION: string = pkg.version;
