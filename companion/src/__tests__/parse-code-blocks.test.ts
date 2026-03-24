import { describe, test, expect } from 'bun:test';
import { parseCodeBlocks } from '../acp-agent';

describe('parseCodeBlocks', () => {
  test('extracts code block with // file path annotation', () => {
    const response = `Here's the fix:

\`\`\`typescript // src/utils/helper.ts
export function add(a: number, b: number): number {
  return a + b;
}
\`\`\`

That should work.`;

    const blocks = parseCodeBlocks(response);
    expect(blocks.length).toBe(1);
    expect(blocks[0].filePath).toBe('src/utils/helper.ts');
    expect(blocks[0].language).toBe('typescript');
    expect(blocks[0].content).toContain('export function add');
  });

  test('extracts multiple code blocks from one response', () => {
    const response = `Update both files:

\`\`\`typescript // src/a.ts
const x = 1;
\`\`\`

\`\`\`rust // src/b.rs
fn main() {}
\`\`\``;

    const blocks = parseCodeBlocks(response);
    expect(blocks.length).toBe(2);
    expect(blocks[0].filePath).toBe('src/a.ts');
    expect(blocks[0].language).toBe('typescript');
    expect(blocks[1].filePath).toBe('src/b.rs');
    expect(blocks[1].language).toBe('rust');
  });

  test('returns empty array when no annotated blocks', () => {
    const response = `Just some text with an unannotated block:

\`\`\`typescript
const x = 1;
\`\`\``;

    const blocks = parseCodeBlocks(response);
    expect(blocks.length).toBe(0);
  });

  test('returns empty array for plain text', () => {
    const blocks = parseCodeBlocks('No code blocks here at all.');
    expect(blocks.length).toBe(0);
  });

  test('handles code block with HTML comment path annotation', () => {
    const response = `\`\`\`python <!-- app/main.py -->
def hello():
    print("world")
\`\`\``;

    const blocks = parseCodeBlocks(response);
    expect(blocks.length).toBe(1);
    expect(blocks[0].filePath).toBe('app/main.py');
    expect(blocks[0].language).toBe('python');
  });

  test('skips code blocks with empty content', () => {
    const response = `\`\`\`typescript // src/empty.ts

\`\`\``;

    const blocks = parseCodeBlocks(response);
    expect(blocks.length).toBe(0);
  });
});
