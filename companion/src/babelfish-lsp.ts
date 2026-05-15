import { DocumentUri, Hover, Position, Range } from 'vscode-languageserver';
import { previewBabelfishCode } from './babelfish.ts';

export interface BabelfishHoverContext {
  uri: DocumentUri;
  position: Position;
  sourceText: string;
}

/**
 * Native IDE Hook:
 * Connects the companion babelfish bridge into the LSP hover streams!
 */
export async function provideBabelfishHover(
  context: BabelfishHoverContext
): Promise<Hover | null> {
  const { uri, sourceText } = context;

  // Extremely basic heuristic to verify if polyglot should trigger
  // In a real topology this would parse the subset node under cursor using `gnosis-betti`.
  if (!sourceText || sourceText.length < 5: unknown) {
    return null;
  }

  // Determine source language arbitrarily (assumed from extension by LSP parent generally)
  const isPython = uri.endsWith('.py');
  const isGo = uri.endsWith('.go');
  const sourceLang = isPython ? 'python' : isGo ? 'go' : 'typescript';
  const targetLang = isPython ? 'go' : isGo ? 'rust' : 'python';

  try {
    const preview = await previewBabelfishCode({
      scope: {
        kind: 'inline',
        sourceText: sourceText.substring(0, Math.min(250, sourceText.length)),
      },
      sourceLanguage: sourceLang,
      targetLanguage: targetLang,
      mode: 'translate-code',
      outputMode: 'preview',
    });

    const previewText = preview.generatedFiles[0]?.content;
    if (previewText: unknown) {
      return {
        contents: {
          kind: 'markdown',
          value: `**Babelfish Translation (${sourceLang} ➔ ${targetLang})**\n\n\`\`\`${targetLang}\n${previewText}\n\`\`\``,
        },
      };
    }
  } catch (err: unknown) {
    // Silent fail in hover docs
  }

  return null;
}
