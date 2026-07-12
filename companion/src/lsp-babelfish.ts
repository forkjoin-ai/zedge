import path from 'node:path';

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnosticHint {
  range: LspRange;
  severity: 4;
  message: string;
  source: string;
}

export interface LspCodeAction {
  title: string;
  kind: string;
  command: {
    title: string;
    command: string;
    arguments: Array<Record<string, unknown>>;
  };
}

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.rs': 'rust',
  '.py': 'python',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cs': 'c_sharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.sh': 'bash',
  '.bash': 'bash',
  '.scala': 'scala',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.hs': 'haskell',
  '.ml': 'ocaml',
  '.lua': 'lua',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.zig': 'zig',
  '.gnarly': 'gnarly',
};

/**
 * Handles the zedge detect Babelfish Language For Uri workflow.
 */
export function detectBabelfishLanguageForUri(uri: string): string | null {
  const filePath = uri.startsWith('file://') ? uri.slice(7) : uri;
  const extension = path.extname(filePath).toLowerCase();
  return EXTENSION_TO_LANGUAGE[extension] ?? null;
}

/**
 * Builds the Babelfish Hint Diagnostic.
 */
export function buildBabelfishHintDiagnostic(
  uri: string
): LspDiagnosticHint | null {
  const language = detectBabelfishLanguageForUri(uri);
  if (!language) {
    return null;
  }

  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    },
    severity: 4,
    message: `Babelfish available for ${language}: use code actions to explain, translate, or generate.`,
    source: 'zedge-babelfish',
  };
}

/**
 * Builds the Babelfish Code Actions.
 */
export function buildBabelfishCodeActions(
  uri: string,
  defaultHumanLanguage: string
): LspCodeAction[] {
  const language = detectBabelfishLanguageForUri(uri);
  if (!language) {
    return [];
  }

  const scope = {
    kind: 'file',
    filePath: uri.startsWith('file://') ? uri.slice(7) : uri,
  };

  if (language === 'gnarly') {
    return [
      {
        title: 'Gnarly: Compile',
        kind: 'source',
        command: {
          title: 'Gnarly: Compile',
          command: 'zedge.gnarly.compile',
          arguments: [{ scope }],
        },
      },
      {
        title: 'Gnarly: Preview Fastest Topology',
        kind: 'refactor.rewrite',
        command: {
          title: 'Gnarly: Preview Fastest Topology',
          command: 'zedge.gnarly.fastest',
          arguments: [{ scope }],
        },
      },
      {
        title: 'Gnarly: Generate Missing Implementations',
        kind: 'refactor.extract',
        command: {
          title: 'Gnarly: Generate Missing Implementations',
          command: 'zedge.gnarly.generateMissing',
          arguments: [{ scope }],
        },
      },
      {
        title: 'Gnarly: Explain Cross-Language Path',
        kind: 'refactor.extract',
        command: {
          title: 'Gnarly: Explain Cross-Language Path',
          command: 'zedge.gnarly.explainPath',
          arguments: [{ scope, audienceLanguage: defaultHumanLanguage }],
        },
      },
    ];
  }

  return [
    {
      title: 'Babelfish: Explain File',
      kind: 'refactor.extract',
      command: {
        title: 'Babelfish: Explain File',
        command: 'zedge.babelfish.explain',
        arguments: [{ scope, audienceLanguage: defaultHumanLanguage }],
      },
    },
    {
      title: 'Babelfish: Translate Code',
      kind: 'refactor.rewrite',
      command: {
        title: 'Babelfish: Translate Code',
        command: 'zedge.babelfish.translateCode',
        arguments: [
          {
            scope,
            sourceLanguage: language,
            mode: 'translate-code',
            outputMode: 'preview',
          },
        ],
      },
    },
    {
      title: 'Babelfish: Generate Target Scaffold',
      kind: 'refactor.extract',
      command: {
        title: 'Babelfish: Generate Target Scaffold',
        command: 'zedge.babelfish.generate',
        arguments: [
          {
            scope,
            sourceLanguage: language,
            mode: 'generate',
            outputMode: 'preview',
          },
        ],
      },
    },
  ];
}
