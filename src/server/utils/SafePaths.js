import fs from 'node:fs';
import path from 'node:path';

export function validateSegment(value, label = 'path segment') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) {
    const error = new Error(`Invalid ${label}`);
    error.status = 400;
    throw error;
  }
  return value;
}

export function assertWithin(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    const error = new Error('Path traversal denied: snapshot path escapes the account directory');
    error.status = 400;
    throw error;
  }
}

// Check existing ancestors as well as the lexical path to reject symlink escapes.
export function assertSafePath(base, target) {
  assertWithin(base, target);
  if (!fs.existsSync(base)) return;
  const realBase = fs.realpathSync(base);
  let ancestor = target;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return;
    ancestor = parent;
  }
  assertWithin(realBase, fs.realpathSync(ancestor));
}
