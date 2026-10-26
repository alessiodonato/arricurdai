import { relativeToRoot } from './reads';
import { resolvePath } from './shell';

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
const oneLine = (value: string, width: number): string => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
};

/** The family of a tool, for the cost breakdown: Read, Bash, Edit/Write, Grep/Glob, Agent, MCP, Web, or the tool name. */
export function toolGroup(name: string): string {
  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit') return 'Edit/Write';
  if (name === 'Grep' || name === 'Glob') return 'Grep/Glob';
  if (name === 'Agent' || name === 'Task') return 'Agent';
  if (name === 'WebFetch' || name === 'WebSearch') return 'Web';
  if (name.startsWith('mcp__')) return 'MCP';
  return name;
}

/**
 * A short label for a tool call: the tool and what it worked on, such as `Read src/app.ts` or
 * `Bash: npm test`. It never contains the result, and a command is cut to one short line.
 */
export function toolLabel(name: string, input: Record<string, unknown>, cwd: string, root: string): string {
  const path = (key: string): string | undefined => {
    const value = text(input[key]);
    return value === undefined ? undefined : relativeToRoot(resolvePath(cwd, value), root);
  };
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return `${name} ${path('file_path') ?? ''}`.trim();
    case 'NotebookEdit':
      return `${name} ${path('notebook_path') ?? ''}`.trim();
    case 'Bash':
      return `Bash: ${oneLine(text(input.command) ?? '', 70)}`;
    case 'Grep':
    case 'Glob':
      return `${name} ${oneLine(text(input.pattern) ?? '', 60)}`.trim();
    case 'Agent':
    case 'Task':
      return `Agent: ${oneLine(text(input.description) ?? text(input.subagent_type) ?? '', 60)}`;
    case 'WebFetch': {
      const url = text(input.url);
      try {
        return url ? `WebFetch ${new URL(url).host}` : name;
      } catch {
        return name;
      }
    }
    default:
      return name;
  }
}
