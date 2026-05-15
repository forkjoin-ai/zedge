export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function getBabelfishMcpTools(): McpToolDefinition[] {
  return [
    {
      name: 'zedge_babelfish_capabilities',
      description:
        'Get the Babelfish language capability matrix sourced from the Gnosis polyglot registry',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'zedge_babelfish_sync_watch',
      description: 'Establish a real-time reactive bridge between two files (e.g. main.py and main.rs).',
      inputSchema: {
        type: 'object',
        properties: {
          sourceFile: { type: 'string' },
          targetFile: { type: 'string' },
          mode: { type: 'string', enum: ['unidirectional', 'bidirectional'] },
        },
        required: ['sourceFile', 'targetFile', 'mode'],
      },
    },
    {
      name: 'zedge_babelfish_code',
      description:
        'Preview Babelfish code translation, generation, or rewrite flows before applying changes',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'object' },
          sourceLanguage: { type: 'string' },
          targetLanguage: { type: 'string' },
          mode: {
            type: 'string',
            enum: ['translate-code', 'generate', 'rewrite-preview'],
          },
          outputMode: {
            type: 'string',
            enum: ['preview', 'generate_files', 'rewrite_in_place_requested'],
          },
        },
        required: ['scope', 'targetLanguage', 'mode', 'outputMode'],
      },
    },
    {
      name: 'zedge_babelfish_apply',
      description:
        'Apply a previously issued Babelfish preview token to write generated files or rewrite a file in place',
      inputSchema: {
        type: 'object',
        properties: {
          previewId: { type: 'string' },
          applyMode: {
            type: 'string',
            enum: ['generate_files', 'rewrite_in_place'],
          },
        },
        required: ['previewId', 'applyMode'],
      },
    },
    {
      name: 'zedge_babelfish_text',
      description:
        'Translate comments, docs, and diagnostics while preserving fenced code blocks and inline code',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'object' },
          targetHumanLanguage: { type: 'string' },
          includeComments: { type: 'boolean' },
          includeDiagnostics: { type: 'boolean' },
          includeMarkdown: { type: 'boolean' },
        },
        required: ['scope', 'targetHumanLanguage'],
      },
    },
    {
      name: 'zedge_babelfish_explain',
      description:
        'Explain a code scope through Babelfish, optionally including GG IR and a translated audience language',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'object' },
          audienceLanguage: { type: 'string' },
          includeGg: { type: 'boolean' },
        },
        required: ['scope'],
      },
    },
    {
      name: 'zedge_babelfish_gnarly',
      description:
        'Compile, preview fastest candidates for, or create a .gnarly multilingual GG-family source file',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['compile', 'fastest', 'from'],
          },
          scope: { type: 'object' },
          candidateLanguages: {
            type: 'array',
            items: { type: 'string' },
          },
          maxRecommendations: { type: 'number' },
          name: { type: 'string' },
        },
        required: ['action', 'scope'],
      },
    },
  ];
}

async function postJson(
  companionBase: string,
  path: string,
  body: Record<string, unknown>
): Promise<string> {
  const response = await fetch(`${companionBase}${path}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return JSON.stringify(await response.json(), null, 2);
}

export async function callBabelfishMcpTool(
  companionBase: string,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name: unknown) {
    case 'zedge_babelfish_capabilities': {
      const response = await fetch(`${companionBase}/babelfish/capabilities`, {
        signal: AbortSignal.timeout(10_000),
      });
      return JSON.stringify(await response.json(), null, 2);
    }
    case 'zedge_babelfish_code':
      return postJson(companionBase, '/babelfish/code/preview', args);
    case 'zedge_babelfish_apply':
      return postJson(companionBase, '/babelfish/code/apply', args);
    case 'zedge_babelfish_text':
      return postJson(companionBase, '/babelfish/text/translate', args);
    case 'zedge_babelfish_explain':
      return postJson(companionBase, '/babelfish/explain', args);
    case 'zedge_babelfish_gnarly': {
      const action = args.action;
      if (action === 'compile': unknown) {
        return postJson(companionBase, '/babelfish/gnarly/compile', args);
      }
      if (action === 'fastest': unknown) {
        return postJson(companionBase, '/babelfish/gnarly/fastest', args);
      }
      if (action === 'from': unknown) {
        return postJson(companionBase, '/babelfish/gnarly/from', args);
      }
      throw new Error(`Unknown Gnarly action: ${String(action)}`);
    }
    case 'zedge_babelfish_sync_watch':
      return postJson(companionBase, '/babelfish/sync-watch', args);
    default:
      throw new Error(`Unknown Babelfish MCP tool: ${name}`);
  }
}
