import { chmodSync, lstatSync, mkdirSync } from 'node:fs';

// Folders where arricurdai keeps files of its own: the state of the guard, the cache of recall. They hold text of
// the sessions, and what is read back from them reaches the agent, so they must belong to this user alone.

/** Whether a folder is of this user and no one else can read or write it. A link to a folder is not. */
export function isPrivateDir(dir: string): boolean {
  try {
    const stats = lstatSync(dir);
    if (!stats.isDirectory()) return false;
    // Windows has no such owners and modes: there the folders of a user are already closed to the others.
    if (typeof process.getuid !== 'function') return true;
    return stats.uid === process.getuid() && (stats.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/** Makes a folder for this user only. Returns false when it is there and is not private. */
export function openPrivateDir(dir: string): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = lstatSync(dir);
  // A folder of this user that was left open to the others is closed to them.
  if (stats.isDirectory() && typeof process.getuid === 'function' && stats.uid === process.getuid() && (stats.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  return isPrivateDir(dir);
}
