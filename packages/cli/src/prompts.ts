// What the user typed in a line of a transcript. Recall and the note after /clear read it the same way.

interface TextBlock {
  type?: string;
  text?: string;
}

/** A prompt of the user, without the wrappers Claude Code adds around pasted text. */
export interface TypedPrompt {
  text: string;
  /** Some of the text was pasted: it may be a log or a message, not words of the user. */
  pasted: boolean;
}

/** Text pasted into a prompt, between tags that carry an id, with the space around the tags. */
const PASTED = /\s*<pasted_content\b[^>]*>([\s\S]*?)<\/pasted_content\b[^>]*>\s*/g;
const PASTED_TAG = /<\/?pasted_content\b[^>]*>/g;

/** The text of a user message: the message itself, or its text blocks. */
export function typedText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as TextBlock[]).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n');
}

/**
 * The prompt in a user message, or undefined when the message is not one: a tool result, the wrapper of a
 * command such as <command-name>, a notice such as [Request interrupted]. A prompt may start with pasted
 * text or with a reference to an image, such as [Image #1]: those are prompts too.
 */
export function typedPrompt(content: unknown): TypedPrompt | undefined {
  const typed = typedText(content).trim();
  if (typed === '') return undefined;
  const startsPasted = /^<pasted_content\b/.test(typed);
  if (!startsPasted && !/^\[Image\b/.test(typed) && /^[<[]/.test(typed)) return undefined;
  // A tag left open, as in a prompt that was cut, goes too: what it held is still the prompt.
  const text = typed.replace(PASTED, (_match, inside: string) => `\n${inside.trim()}\n`).replace(PASTED_TAG, '').trim();
  if (text === '') return undefined;
  return { text, pasted: text !== typed };
}
