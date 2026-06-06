import fs from 'fs';
import path from 'path';

/**
 * Human-facing app version, read once from package.json at runtime.
 *
 * Distinct from the build commit (`GIT_COMMIT`): the version is the legible
 * "v0.x.y" the end-user tracks, the commit is the exact build behind it. Read via
 * fs (not a JSON import) so it works under both `tsx` (src/) and compiled `dist/`
 * without tripping tsconfig's `rootDir` (package.json sits one level above both).
 * Falls back to 'dev' if package.json can't be read.
 */
let cached: string | null = null;

export function getAppVersion(): string {
  if (cached !== null) return cached;
  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    cached = (JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version as string) || 'dev';
  } catch {
    cached = 'dev';
  }
  return cached;
}
