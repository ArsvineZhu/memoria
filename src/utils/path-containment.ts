import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Check resolved filesystem containment. Missing target suffixes are appended
 * to the nearest existing ancestor so symlink/junction escapes are rejected
 * before the target is read or written.
 */
export function isRealPathContained(rootPath: string, targetPath: string): boolean {
  if (!fs.existsSync(rootPath)) return true;

  const realRoot = fs.realpathSync.native(rootPath);
  let probe = path.resolve(targetPath);
  const missingSuffix: string[] = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return true;
    missingSuffix.unshift(path.basename(probe));
    probe = parent;
  }

  const realProbe = fs.realpathSync.native(probe);
  const realTarget = path.resolve(realProbe, ...missingSuffix);
  const realRelative = path.relative(realRoot, realTarget);
  return Boolean(
    realRelative &&
      realRelative !== ".." &&
      !realRelative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(realRelative),
  );
}
