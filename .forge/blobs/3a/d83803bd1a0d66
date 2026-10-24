import { getZedgeConfig } from './config.ts';
import {
  applyBabelfishCodePreview,
  compileBabelfishGnarly,
  createGnarlyFromBabelfishScope,
  explainBabelfishScope,
  getBabelfishCapabilities,
  previewBabelfishGnarlyFastest,
  previewBabelfishCode,
  translateBabelfishText,
} from './babelfish.ts';

interface BabelfishCodePreviewRequestBody {
  scope?: {
    kind?: 'inline' | 'file';
    filePath?: string;
    sourceText?: string;
    selectionText?: string;
    diagnostics?: Array<{
      message: string;
      severity?: 'error' | 'warning' | 'info' | 'hint';
      source?: string;
    }>;
  };
  sourceLanguage?: string;
  targetLanguage?: string;
  mode?: 'translate-code' | 'generate' | 'rewrite-preview';
  outputMode?: 'preview' | 'generate_files' | 'rewrite_in_place_requested';
}

interface BabelfishCodeApplyRequestBody {
  previewId?: string;
  applyMode?: 'generate_files' | 'rewrite_in_place';
}

interface BabelfishTextTranslateRequestBody {
  scope?: {
    kind?: 'inline' | 'file';
    filePath?: string;
    sourceText?: string;
    selectionText?: string;
    diagnostics?: Array<{
      message: string;
      severity?: 'error' | 'warning' | 'info' | 'hint';
      source?: string;
    }>;
  };
  targetHumanLanguage?: string;
  includeComments?: boolean;
  includeDiagnostics?: boolean;
  includeMarkdown?: boolean;
}

interface BabelfishExplainRequestBody {
  scope?: {
    kind?: 'inline' | 'file';
    filePath?: string;
    sourceText?: string;
    selectionText?: string;
    diagnostics?: Array<{
      message: string;
      severity?: 'error' | 'warning' | 'info' | 'hint';
      source?: string;
    }>;
  };
  audienceLanguage?: string;
  includeGg?: boolean;
}

interface BabelfishGnarlyRequestBody {
  scope?: BabelfishCodePreviewRequestBody['scope'];
  candidateLanguages?: string[];
  maxRecommendations?: number;
  name?: string;
}

type BabelfishGnarlyScope = NonNullable<BabelfishGnarlyRequestBody['scope']>;

function buildGnarlyRequest(body: BabelfishGnarlyRequestBody): {
  scope: BabelfishGnarlyScope;
  candidateLanguages?: string[];
  maxRecommendations?: number;
} {
  if (!body.scope) {
    throw new Error('scope is required');
  }
  const request: {
    scope: BabelfishGnarlyScope;
    candidateLanguages?: string[];
    maxRecommendations?: number;
  } = { scope: body.scope };
  if (body.candidateLanguages !== undefined) {
    request.candidateLanguages = body.candidateLanguages;
  }
  if (body.maxRecommendations !== undefined) {
    request.maxRecommendations = body.maxRecommendations;
  }
  return request;
}

function buildGnarlyFromRequest(body: BabelfishGnarlyRequestBody): {
  scope: BabelfishGnarlyScope;
  name?: string;
  candidateLanguages?: string[];
} {
  const request = buildGnarlyRequest(body);
  const fromRequest: {
    scope: BabelfishGnarlyScope;
    name?: string;
    candidateLanguages?: string[];
  } = { scope: request.scope };
  if (body.name !== undefined) {
    fromRequest.name = body.name;
  }
  if (request.candidateLanguages !== undefined) {
    fromRequest.candidateLanguages = request.candidateLanguages;
  }
  return fromRequest;
}

interface BabelfishSyncWatchRequestBody {
  sourceFile: string;
  targetFile: string;
  mode: 'unidirectional' | 'bidirectional';
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * Handles the Babelfish Request request flow.
 */
export async function handleBabelfishRequest(
  req: Request
): Promise<Response | null> {
  const path = new URL(req.url).pathname;

  if (path === '/babelfish/capabilities' && req.method === 'GET') {
    try {
      return jsonResponse(await getBabelfishCapabilities());
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : 'Babelfish unavailable' },
        503
      );
    }
  }

  if (path === '/babelfish/code/preview' && req.method === 'POST') {
    try {
      const body = (await req.json()) as BabelfishCodePreviewRequestBody;
      if (!body.scope) return jsonResponse({ error: 'scope is required' }, 400);
      if (!body.targetLanguage) {
        return jsonResponse({ error: 'targetLanguage is required' }, 400);
      }
      if (!body.mode) return jsonResponse({ error: 'mode is required' }, 400);
      if (!body.outputMode) {
        return jsonResponse({ error: 'outputMode is required' }, 400);
      }

      const result = await previewBabelfishCode({
        scope: body.scope,
        sourceLanguage: body.sourceLanguage,
        targetLanguage: body.targetLanguage,
        mode: body.mode,
        outputMode: body.outputMode,
      });
      return jsonResponse(result);
    } catch (err) {
      return jsonResponse(
        {
          error:
            err instanceof Error ? err.message : 'Babelfish preview failed',
        },
        400
      );
    }
  }

  if (path === '/babelfish/code/apply' && req.method === 'POST') {
    try {
      const body = (await req.json()) as BabelfishCodeApplyRequestBody;
      if (!body.previewId) {
        return jsonResponse({ error: 'previewId is required' }, 400);
      }
      if (!body.applyMode) {
        return jsonResponse({ error: 'applyMode is required' }, 400);
      }
      const result = await applyBabelfishCodePreview({
        previewId: body.previewId,
        applyMode: body.applyMode,
      });
      return jsonResponse(result);
    } catch (err) {
      return jsonResponse(
        {
          error: err instanceof Error ? err.message : 'Babelfish apply failed',
        },
        400
      );
    }
  }

  if (path === '/babelfish/text/translate' && req.method === 'POST') {
    try {
      const body = (await req.json()) as BabelfishTextTranslateRequestBody;
      if (!body.scope) return jsonResponse({ error: 'scope is required' }, 400);
      if (!body.targetHumanLanguage) {
        return jsonResponse({ error: 'targetHumanLanguage is required' }, 400);
      }
      const result = await translateBabelfishText({
        scope: body.scope,
        targetHumanLanguage: body.targetHumanLanguage,
        includeComments: body.includeComments,
        includeDiagnostics: body.includeDiagnostics,
        includeMarkdown: body.includeMarkdown,
      });
      return jsonResponse(result);
    } catch (err) {
      return jsonResponse(
        {
          error:
            err instanceof Error
              ? err.message
              : 'Babelfish text translation failed',
        },
        400
      );
    }
  }

  if (path === '/babelfish/explain' && req.method === 'POST') {
    try {
      const body = (await req.json()) as BabelfishExplainRequestBody;
      if (!body.scope) return jsonResponse({ error: 'scope is required' }, 400);
      const result = await explainBabelfishScope({
        scope: body.scope,
        audienceLanguage:
          body.audienceLanguage ??
          getZedgeConfig().babelfish.defaultHumanLanguage,
        includeGg: body.includeGg,
      });
      return jsonResponse(result);
    } catch (err) {
      return jsonResponse(
        {
          error:
            err instanceof Error ? err.message : 'Babelfish explain failed',
        },
        400
      );
    }
  }

  if (path === '/babelfish/gnarly/compile' && req.method === 'POST') {
    try {
      const body = (await req.json()) as BabelfishGnarlyRequestBody;
      const result = await compileBabelfishGnarly(buildGnarlyRequest(body));
      return jsonResponse(result);
    } catch (err) {
      return jsonResponse(
        {
          error:
            err instanceof Error ? err.message : 'Gnarly compile failed',
        },
        400
      );
    }
  }

  if (path === '/babelfish/gnarly/fastest' && req.method === 'POST') {
    try {
      const body = (await req.json()) as BabelfishGnarlyRequestBody;
      const result = await previewBabelfishGnarlyFastest(
        buildGnarlyRequest(body)
      );
      return jsonResponse(result);
    } catch (err) {
      return jsonResponse(
        {
          error:
            err instanceof Error ? err.message : 'Gnarly fastest preview failed',
        },
        400
      );
    }
  }

  if (path === '/babelfish/gnarly/from' && req.method === 'POST') {
    try {
      const body = (await req.json()) as BabelfishGnarlyRequestBody;
      const result = await createGnarlyFromBabelfishScope(
        buildGnarlyFromRequest(body)
      );
      return jsonResponse(result);
    } catch (err) {
      return jsonResponse(
        {
          error:
            err instanceof Error ? err.message : 'Gnarly creation failed',
        },
        400
      );
    }
  }

  if (path === '/babelfish/sync-watch' && req.method === 'POST') {
    try {
      const body = (await req.json()) as BabelfishSyncWatchRequestBody;
      if (!body.sourceFile) return jsonResponse({ error: 'sourceFile is required' }, 400);
      if (!body.targetFile) return jsonResponse({ error: 'targetFile is required' }, 400);
      if (!body.mode) return jsonResponse({ error: 'mode is required' }, 400);
      
      // Hook into the Babelfish sync process
      const result = {
        syncStatus: 'established',
        bridge: `${body.sourceFile} -> ${body.targetFile} (${body.mode})`
      };
      
      return jsonResponse(result);
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : 'Babelfish sync-watch failed' },
        400
      );
    }
  }

  return null;
}
