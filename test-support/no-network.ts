import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// arricurdAI runs on transcripts that hold private code, so its packages may only use the modules
// each one lists. Anything else, a network module included, fails the test of that package.

const NETWORK_CALLS = /\b(fetch|WebSocket|XMLHttpRequest|EventSource)\s*\(/;

/**
 * Every module a piece of code imports or requires, relative paths excluded. Static imports are
 * matched at the start of a line, where both the sources and the build put them, so that a string
 * such as 'import' in the code is not taken for one.
 */
export function importedModules(code: string): string[] {
  const patterns = [
    /^\s*(?:import|export)\b[^'"\n]*\bfrom\s*['"]([^'"]+)['"]/gm,
    /^\s*\}\s*from\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  const modules = new Set<string>();
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) modules.add(match[1]!);
  return [...modules].filter((name) => !name.startsWith('.')).sort();
}

function codeFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.(ts|js|mjs)$/.test(name) && !name.endsWith('.d.ts'))
    .map((name) => join(dir, name));
}

export interface NetworkCheck {
  /** Modules imported by the source or the build that are not allowed, with the file that imports them. */
  forbiddenImports: string[];
  /** Calls to fetch, WebSocket, XMLHttpRequest or EventSource. */
  networkCalls: string[];
  /** Dependencies in package.json that are not allowed. */
  forbiddenDependencies: string[];
}

/** Checks the source (`src`), the build (`dist`) and the dependencies of a package against a list of allowed modules. */
export function checkPackage(packageDir: string, allowed: readonly string[]): NetworkCheck {
  const check: NetworkCheck = { forbiddenImports: [], networkCalls: [], forbiddenDependencies: [] };
  // The build writes Node built-ins without the node: prefix, so `fs` and `node:fs` are the same module.
  const builtin = (name: string): string => name.replace(/^node:/, '');
  const allowedModules = new Set(allowed.map(builtin));
  for (const file of [...codeFiles(join(packageDir, 'src')), ...codeFiles(join(packageDir, 'dist'))]) {
    const code = readFileSync(file, 'utf8');
    const where = relative(packageDir, file);
    for (const name of importedModules(code)) if (!allowedModules.has(builtin(name))) check.forbiddenImports.push(`${where}: ${name}`);
    if (NETWORK_CALLS.test(code)) check.networkCalls.push(where);
  }
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  for (const name of Object.keys(manifest.dependencies ?? {})) if (!allowed.includes(name)) check.forbiddenDependencies.push(name);
  return check;
}
