import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from '@a0n/gnosis/test';
import { readFileSync } from 'node:fs';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function createEventStream(
  lines: string[] = ['data: {"type":"connected"}\n\n']
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
}

interface RuntimeState {
  feedbackEntries: Array<Record<string, unknown>>;
  logs: string[];
  poolJoined: boolean;
  meshRunning: boolean;
  agentSessions: Map<
    string,
    {
      id: string;
      workspacePath: string;
      capabilities: Record<string, unknown>;
    }
  >;
  nextAgentSessionId: number;
  cloudSessions: Map<string, { id: string; status: string }>;
  engrams: Map<
    string,
    {
      id: string;
      type: string;
      content: string;
      filePath?: string;
    }
  >;
}

const state: RuntimeState = {
  feedbackEntries: [],
  logs: [],
  poolJoined: false,
  meshRunning: false,
  agentSessions: new Map(),
  nextAgentSessionId: 1,
  cloudSessions: new Map(),
  engrams: new Map(),
};

function resetState(): void {
  state.feedbackEntries = [];
  state.logs = ['boot ok'];
  state.poolJoined = false;
  state.meshRunning = false;
  state.agentSessions = new Map();
  state.nextAgentSessionId = 1;
  state.cloudSessions = new Map();
  state.engrams = new Map();
}

resetState();

mock.module('@a0n/x-gnosis/server', () => ({
  XGnosisServer: class {
    constructor(_options?: unknown) {}
    async listen(): Promise<void> {}
  },
}));

mock.module('@a0n/x-gnosis/gnosis-uring-command', () => ({
  resolveGnosisUringCommand: () => ({
    command: 'echo',
    args: ['mock-gnosis-uring'],
    display: 'echo mock-gnosis-uring',
  }),
}));

mock.module('../config.ts', () => ({
  getCompanionPort: () => 7331,
  getZedgeConfig: () => ({
    port: 7331,
    preferredModel: 'tinyllama-1.1b',
    cloudRunDirect: false,
    computePool: {
      enabled: false,
      maxCpuPercent: 50,
      maxMemoryMb: 2048,
      allowedModels: ['tinyllama-1.1b'],
    },
    babelfish: {
      enabled: true,
      ambientSuggestions: true,
      defaultHumanLanguage: 'en',
      requirePreviewForInPlaceRewrite: true,
    },
    listener: {
      mode: 'bun',
      internalPort: 7331,
      threads: 1,
      flowPort: 7332,
      useUring: false,
    },
  }),
}));

mock.module('../prompt-budget.ts', () => ({
  applySystemPromptBudget: (_model: string, messages: unknown) => messages,
  shouldSkipHeavySystemContext: () => true,
}));

mock.module('../chat-request.ts', () => ({
  shouldStreamChatCompletion: (stream?: boolean) => Boolean(stream),
}));

mock.module('../aether-local-runtime.ts', () => ({
  aetherLocalRuntime: {
    chatStatus: 'ready',
    modelId: 'wasm-local',
    localEmbeddingModelId: 'minilm-local',
  },
}));

mock.module('../companion-activity.ts', () => ({
  getOwnedCompanionActivity: () => null,
}));

mock.module('../feedback-log.ts', () => ({
  getRecentFeedback: (count: number) => state.feedbackEntries.slice(-count),
  recordFeedback: (entry: Record<string, unknown>) => {
    const saved = {
      id: `feedback-${state.feedbackEntries.length + 1}`,
      createdAt: Date.now(),
      ...entry,
    };
    state.feedbackEntries.push(saved);
    return saved;
  },
}));

mock.module('../compute-node.ts', () => ({
  joinPool: async () => {
    state.poolJoined = true;
    return {
      joined: true,
      tokensEarned: 0,
      requestsServed: 0,
    };
  },
  leavePool: async () => {
    state.poolJoined = false;
    return {
      joined: false,
      tokensEarned: 0,
      requestsServed: 0,
    };
  },
  getPoolStatus: () => ({
    joined: state.poolJoined,
    tokensEarned: 0,
    requestsServed: 0,
  }),
  getMarketStatus: () => ({
    available: true,
    joined: state.poolJoined,
  }),
}));

mock.module('../p2p-mesh.ts', () => ({
  startMesh: () => {
    state.meshRunning = true;
    return {
      running: true,
      nodeId: 'mesh-node',
      peers: [],
      totalCapacity: {
        models: ['tinyllama-1.1b'],
        totalCores: 4,
        totalMemoryMb: 2048,
      },
    };
  },
  stopMesh: () => {
    state.meshRunning = false;
    return {
      running: false,
      nodeId: 'mesh-node',
      peers: [],
      totalCapacity: {
        models: [],
        totalCores: 0,
        totalMemoryMb: 0,
      },
    };
  },
  getMeshStatus: () => ({
    running: state.meshRunning,
    nodeId: 'mesh-node',
    peers: [],
    totalCapacity: {
      models: state.meshRunning ? ['tinyllama-1.1b'] : [],
      totalCores: state.meshRunning ? 4 : 0,
      totalMemoryMb: state.meshRunning ? 2048 : 0,
    },
  }),
  handlePeerRequest: async () =>
    jsonResponse({
      id: 'mesh-peer-response',
      choices: [{ message: { role: 'assistant', content: 'peer ok' } }],
    }),
}));

mock.module('../auth.ts', () => ({
  login: async () => ({
    success: true,
    pending: false,
    verificationUri: 'https://example.test/verify',
    userCode: 'ABCD-EFGH',
  }),
  logout: () => undefined,
  whoami: () => ({
    authenticated: false,
    provider: 'mock',
  }),
}));

mock.module('../coordinator-urls.ts', () => ({
  hasCloudRunCoordinators: () => false,
}));

mock.module('../latency-probe.ts', () => ({
  getTierHealth: () => ({
    edge: 'healthy',
    wasm: 'healthy',
  }),
  getProbeResults: () => [
    {
      model: 'tinyllama-1.1b',
      tier: 'edge',
      ms: 12,
    },
  ],
  getFastestTier: () => 'edge',
}));

mock.module('../selftest.ts', () => ({
  runInferenceSelfTest: async (model: string) => ({
    ok: true,
    model,
    tier: 'edge',
  }),
}));

mock.module('../stream-reconnect.ts', () => ({
  createResilientStream: () =>
    createEventStream(['data: {"type":"delta","content":"ok"}\n\n']),
  getActiveSessions: () => [],
}));

mock.module('../superinference.ts', () => {
  const preset = {
    name: 'Fast',
    description: 'Mock preset',
    models: ['tinyllama-1.1b'],
    strategy: 'fastest',
  };
  return {
    superinfer: async () => ({
      strategy: 'fastest',
      winner: 'tinyllama-1.1b',
      content: 'ok',
    }),
    recursiveSuperinfer: async () => ({
      strategy: 'consensus',
      depth: 1,
      content: 'ok',
    }),
    superinferWithPreset: async () => ({
      preset: 'fast',
      content: 'ok',
    }),
    getCompositionPreset: (key: string) => (key === 'fast' ? preset : null),
    COMPOSITION_PRESETS: {
      fast: preset,
    },
  };
});

mock.module('../acp-agent.ts', () => ({
  createSession: (
    workspacePath: string,
    capabilities: Record<string, unknown>
  ) => {
    const session = {
      id: `agent-session-${state.nextAgentSessionId++}`,
      workspacePath,
      capabilities,
    };
    state.agentSessions.set(session.id, session);
    return session;
  },
  getSession: (sessionId: string) => state.agentSessions.get(sessionId) ?? null,
  deleteSession: (sessionId: string) => {
    state.agentSessions.delete(sessionId);
  },
  agentTurn: async (_sessionId: string, message: string) => ({
    reply: `echo:${message}`,
    tool_calls: [],
  }),
}));

mock.module('../binary-protocol.ts', () => ({
  encode: (frame: unknown) => new TextEncoder().encode(JSON.stringify(frame)),
  decode: (buffer: ArrayBuffer) =>
    JSON.parse(new TextDecoder().decode(new Uint8Array(buffer))),
  isValidFrame: () => true,
  CONTENT_TYPE: 'application/x-zedge-binary',
}));

mock.module('../inference-bridge.ts', () => ({
  infer: async (request: { model?: string }) => ({
    tier: 'edge',
    upstreamHeaders: {
      'X-Mock-Upstream': 'true',
    },
    attempts: [{ tier: 'edge', status: 'ok', ms: 1 }],
    response: jsonResponse({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: 123,
      model: request.model ?? 'tinyllama-1.1b',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'mock completion',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    }),
  }),
  inferFim: async (
    _prefix: string,
    _suffix: string,
    model: string,
    _maxTokens: number,
    _temperature: number
  ) => ({
    completion: 'mock-fim',
    model,
    tier: 'edge',
    durationMs: 2,
    attempts: [{ tier: 'edge', status: 'ok', ms: 2 }],
  }),
  buildFimPrompt: () => '',
  getModels: async () => [
    {
      id: 'tinyllama-1.1b',
      object: 'model',
      created: 0,
      owned_by: 'mock',
    },
  ],
  embed: async (_input: string | string[], model?: string) =>
    jsonResponse({
      object: 'list',
      data: [
        {
          object: 'embedding',
          index: 0,
          embedding: [0.1, 0.2],
        },
      ],
      model: model ?? 'mock-embed',
      usage: {
        prompt_tokens: 1,
        total_tokens: 1,
      },
    }),
  createSSEProxyStream: () => createEventStream(['data: [DONE]\n\n']),
  getRecentLogs: (count: number) => state.logs.slice(-count),
  clearLogs: () => {
    state.logs = [];
  },
}));

mock.module('../babelfish-routes.ts', () => ({
  handleBabelfishRequest: async (request: Request) => {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith('/babelfish/')) {
      return null;
    }
    return jsonResponse({
      ok: true,
      path: pathname,
    });
  },
}));

mock.module('../code-index.ts', () => ({
  codeIndex: {
    search: async (query: string, topK = 5) =>
      query
        ? [
            {
              block: {
                relativePath: 'src/example.ts',
                startLine: 1,
                endLine: 2,
                content: 'export const value = 1;',
                language: 'ts',
                kind: 'function',
              },
              score: topK > 0 ? 0.9 : 0,
            },
          ]
        : [],
    getRelatedContext: async () => [
      {
        block: {
          relativePath: 'src/example.ts',
          startLine: 3,
          endLine: 4,
          content: 'export const related = 2;',
          language: 'ts',
          kind: 'const',
        },
        score: 0.8,
      },
    ],
    getStats: () => ({
      indexedBlocks: 1,
      indexedFiles: 1,
    }),
    reindexFile: async () => undefined,
  },
}));

mock.module('../gnot-bridge.ts', () => ({
  listWorkspaceGnotFiles: () => [
    {
      filePath: 'open-source/gnot/examples/apps-hello-world.gnot',
      appId: 'apps-hello-world',
      version: '0.9',
    },
  ],
  handleGnotCommand: async (input: {
    action: string;
    filePath?: string;
    app?: string;
    environment?: string;
  }) => ({
    action: input.action,
    filePath: input.filePath ?? null,
    app: input.app ?? null,
    environment: input.environment ?? null,
    ok: true,
  }),
}));

mock.module('../gnosis-viz.ts', () => ({
  default: () =>
    new Response('<html><body>mock gnosis viz</body></html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }),
}));

mock.module('../agent-swarm.ts', () => ({
  AgentSwarm: class {
    constructor(_bridge?: unknown) {}
    static listRoles(): string[] {
      return ['reviewer'];
    }
    async start(): Promise<Record<string, unknown>> {
      return { started: true };
    }
  },
}));

mock.module('../agent-roles.ts', () => ({
  AGENT_ROLES: {
    reviewer: {
      id: 'reviewer',
      displayName: 'Reviewer',
      mode: 'review',
      strategy: 'parallel',
      color: '#123456',
      filePattern: '**/*',
    },
  },
}));

mock.module('../theme-engine.ts', () => ({
  getThemePalette: (filePath?: string) => ({
    filePath: filePath ?? null,
    accent: '#008080',
  }),
}));

mock.module('../cloud-agent-session.ts', () => ({
  startCloudAgent: async (input: {
    agentName: string;
    task: string;
    targetFiles?: string[];
    model?: string;
  }) => {
    const id = `cloud-${state.cloudSessions.size + 1}`;
    const session = {
      id,
      status: 'running',
      ...input,
    };
    state.cloudSessions.set(id, session);
    return session;
  },
  listSessions: () => Array.from(state.cloudSessions.values()),
  getSession: (sessionId: string) => state.cloudSessions.get(sessionId),
  createSessionStream: (_sessionId: string) =>
    createEventStream(['data: {"type":"cloud-agent","status":"running"}\n\n']),
  cancelSession: (sessionId: string) => state.cloudSessions.delete(sessionId),
}));

mock.module('../topology-runner.ts', () => ({
  runTopology: async (input: { filePath: string }) => ({
    success: true,
    filePath: input.filePath,
  }),
  createRunStream: () =>
    createEventStream(['data: {"type":"run","status":"ready"}\n\n']),
}));

mock.module('../observatory.ts', () => ({
  getObservatorySnapshot: async () => ({
    status: 'ok',
    signals: [],
  }),
  createObservatoryStream: () =>
    createEventStream(['data: {"type":"observatory","status":"ok"}\n\n']),
}));

mock.module('../observatory-history.ts', () => ({
  computeTrends: () => [],
  computeSystemVoidBoundary: () => ({
    boundary: 0,
  }),
  getHistory: (limit: number) =>
    Array.from({ length: Math.min(limit, 1) }, (_, index) => ({
      id: index + 1,
      value: 'history-entry',
    })),
  getHistorySize: () => 1,
}));

mock.module('../federated-void-sync.ts', () => ({
  federatedVoidSync: {
    getStatus: () => ({
      connected: false,
      handshakes: 0,
    }),
    initiateHandshake: (targetDeviceId: string, token: string) => ({
      targetDeviceId,
      token,
      accepted: false,
    }),
    acceptHandshake: () => true,
    receiveDeficit: () => true,
    getHandshakes: () => [],
  },
}));

mock.module('../void-sync-transport.ts', () => ({
  connectVoidSyncRoom: async (workspaceId: string) => ({
    workspaceId,
    connected: true,
  }),
  disconnectVoidSyncRoom: () => undefined,
  getRoomStatus: () => ({
    connected: false,
  }),
  computeLineScopedDeficit: (filePath: string, range: [number, number]) => ({
    filePath,
    range,
    deficit: 0,
  }),
  getFileDeficitMap: (filePath: string) => [
    {
      filePath,
      startLine: 1,
      endLine: 1,
      deficit: 0,
    },
  ],
}));

mock.module('../agent-breeding.ts', () => ({
  agentBreeding: {
    getStatus: () => ({
      cycles: 0,
      running: false,
    }),
    runCycle: async () => ({
      ok: true,
      cycle: 1,
    }),
  },
  createBreedingStream: () =>
    createEventStream(['data: {"type":"breeding","status":"idle"}\n\n']),
}));

mock.module('../neural-bridge.ts', () => ({
  neuralBridge: {
    getStatus: () => ({
      ready: true,
    }),
    getLearnedSteering: () => ({
      focus: 0.5,
    }),
    getLearnedSteeringPrompt: () => 'Focus on correctness.',
  },
}));

mock.module('../daydream.ts', () => ({
  daydreamEngine: {
    getStatus: () => ({
      ready: true,
    }),
    getCandidates: () => [],
    triggerDream: async (filePath?: string) => ({
      filePath: filePath ?? null,
      queued: true,
    }),
    acceptCandidate: () => null,
    rejectCandidate: () => null,
    notifyActivity: () => undefined,
  },
}));

mock.module('../daydream-annotations.ts', () => ({
  createAnnotationStream: () =>
    createEventStream(['data: {"type":"annotation","status":"ok"}\n\n']),
  getAnnotationClientCount: () => 0,
  convertToDiagnostics: () => [],
}));

mock.module('../wire-phase3.ts', () => ({
  getPhase3Status: () => ({
    wired: false,
  }),
  wirePhase3: async () => ({
    wired: true,
  }),
}));

mock.module('../void-map-store.ts', () => ({
  voidMapStore: {
    getStatus: () => ({
      entries: 0,
    }),
    query: () => [],
    getSteeringVector: () => ({
      filePath: null,
      weights: {},
    }),
    compact: () => 0,
  },
}));

mock.module('../void-map-export.ts', () => ({
  exportForTraining: () => ({
    exported: 0,
  }),
  exportRecords: () => [],
}));

mock.module('../engram-store.ts', () => ({
  getEngramStore: () => ({
    getStatus: () => ({
      count: state.engrams.size,
    }),
    recall: async () => [],
    remember: async (input: {
      type: string;
      content: string;
      filePath?: string;
    }) => {
      const id = `engram-${state.engrams.size + 1}`;
      const engram = { id, ...input };
      state.engrams.set(id, engram);
      return engram;
    },
    forget: (id: string) => state.engrams.delete(id),
  }),
}));

mock.module('../multi-file-agent.ts', () => ({
  executeMultiFileEdit: async () => ({
    appliedCount: 1,
    failedCount: 0,
    results: [],
  }),
}));

mock.module('../agent-participant.ts', () => ({
  AgentParticipant: class {
    private readonly files = new Map<string, string>();

    constructor(
      private readonly input: { agentId: string; model: string; mode: string }
    ) {}

    async join(): Promise<void> {}
    leave(): void {}

    getStatus(): Record<string, unknown> {
      return {
        agentId: this.input.agentId,
        model: this.input.model,
        mode: this.input.mode,
      };
    }

    async openFile(
      path: string,
      initialContent?: string
    ): Promise<Record<string, unknown>> {
      this.files.set(path, initialContent ?? '');
      return {
        path,
        content: this.files.get(path) ?? '',
      };
    }

    readFile(path: string): string | null {
      return this.files.get(path) ?? null;
    }

    insert(path: string, _offset: number, text: string): boolean {
      this.files.set(path, (this.files.get(path) ?? '') + text);
      return true;
    }

    delete(path: string): boolean {
      return this.files.delete(path);
    }

    replace(
      path: string,
      _offset: number,
      _length: number,
      text: string
    ): boolean {
      this.files.set(path, text);
      return true;
    }

    applyEdits(): boolean {
      return true;
    }

    applyReplacements(): boolean {
      return true;
    }

    addSuggestion(): void {}
    addReviewComment(): void {}
    setThinking(): void {}
    undo(): void {}
    redo(): void {}
  },
}));

mock.module('../ucan-scope.ts', () => ({
  generateInvite: (
    peerId: string,
    room: string,
    mode: string,
    ttlMs?: number
  ) => ({
    peerId,
    room,
    mode,
    ttlMs,
  }),
  parseRoomUcan: () => ({
    room: 'room-1',
    capabilities: ['read'],
  }),
  isRoomUcanExpired: () => false,
}));

const { handleWebRequest, zedgeControlSurface } = await import('../server.ts');

type RouteCase = {
  key: string;
  request: () => Request;
  expectedStatus: number | number[];
  verify?: (response: Response) => Promise<void> | void;
};

function createRequest(
  path: string,
  init: {
    method?: 'GET' | 'POST' | 'DELETE' | 'OPTIONS';
    json?: unknown;
    headers?: Record<string, string>;
    body?: BodyInit;
  } = {}
): Request {
  const headers = new Headers(init.headers);
  let body = init.body;

  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  }

  return new Request(`http://localhost:7331${path}`, {
    method: init.method ?? 'GET',
    headers,
    body,
  });
}

function getCase(
  path: string,
  expectedStatus: number | number[],
  verify?: RouteCase['verify']
): RouteCase {
  return {
    key: `GET ${path}`,
    request: () => createRequest(path),
    expectedStatus,
    verify,
  };
}

function postCase(
  path: string,
  expectedStatus: number | number[],
  json: unknown = {},
  verify?: RouteCase['verify']
): RouteCase {
  return {
    key: `POST ${path}`,
    request: () => createRequest(path, { method: 'POST', json }),
    expectedStatus,
    verify,
  };
}

function deleteCase(
  path: string,
  expectedStatus: number | number[],
  verify?: RouteCase['verify']
): RouteCase {
  return {
    key: `DELETE ${path}`,
    request: () => createRequest(path, { method: 'DELETE' }),
    expectedStatus,
    verify,
  };
}

function prefixCase(
  key: string,
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  expectedStatus: number | number[],
  json?: unknown,
  verify?: RouteCase['verify']
): RouteCase {
  return {
    key,
    request: () =>
      createRequest(path, {
        method,
        json,
      }),
    expectedStatus,
    verify,
  };
}

function expectSse(response: Response): void {
  expect(response.headers.get('content-type')).toContain('text/event-stream');
}

function parseRouteInventory(): Set<string> {
  const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  const exact = [
    ...source.matchAll(
      /if \(\s*path === '([^']+)'\s*&&\s*req\.method === '([A-Z]+)'\s*\)/gs
    ),
  ].map((match) => `${match[2]} ${match[1]}`);
  const prefix = [
    ...source.matchAll(
      /if \(\s*path\.startsWith\('([^']+)'\)\s*&&\s*req\.method === '([A-Z]+)'\s*\)/gs
    ),
  ].map((match) => `${match[2]} ${match[1]}*`);
  return new Set([...exact, ...prefix]);
}

const routeCases: RouteCase[] = [
  getCase('/health', 200, async (response) => {
    const payload = (await response.clone().json()) as Record<string, unknown>;
    expect(payload.status).toBe('ok');
    expect(payload.preferredModel).toBe('tinyllama-1.1b');
  }),
  ...[
    '/logs',
    '/fim/stats',
    '/feedback',
    '/edgework/commands',
    '/scaffold/templates',
    '/gnot/files',
    '/code-index/stats',
    '/gnosis/viz',
    '/gnosis/watcher/stats',
    '/admin/commands',
    '/v1/models',
    '/compute-pool/status',
    '/mesh/status',
    '/agent/swarm/roles',
    '/theme/current',
    '/cloud-agent/sessions',
    '/observatory',
    '/observatory/trends',
    '/observatory/void-boundary',
    '/observatory/history',
    '/void-sync/status',
    '/void-sync/handshakes',
    '/void-sync/room',
    '/breeding/status',
    '/auth/whoami',
    '/probe/health',
    '/probe/results',
    '/probe/fastest',
    '/selftest/inference',
    '/neural/status',
    '/neural/steering',
    '/neural/categories',
    '/stream/sessions',
    '/cera/daydream/status',
    '/cera/daydream/candidates',
    '/phase3/status',
    '/void-map/status',
    '/void-map/query',
    '/void-map/steering',
    '/void-map/export/records',
    '/engram/status',
    '/v1/superinference/presets',
    '/market/status',
    '/agent-participant/status',
  ].map((path) => getCase(path, 200)),
  ...[
    '/gnosis/viz/events',
    '/gnosis/run/stream',
    '/observatory/stream',
    '/breeding/stream',
    '/cera/daydream/annotations',
  ].map((path) => getCase(path, 200, expectSse)),
  ...[
    '/code-index/related',
    '/void-sync/line-deficit',
    '/cera/daydream/annotations/diagnostics',
    '/agent-participant/read',
  ].map((path) => getCase(path, 400)),
  ...[
    '/forge/status',
    '/forge/projects',
    '/cera/status',
    '/cera/mutations',
    '/cera/history',
    '/cera/events',
    '/forge/events',
    '/vfs/mounts',
    '/vfs/changes',
    '/collab/sessions',
    '/kernel/commands',
    '/kernel/daemons',
    '/kernel/plugins',
    '/kernel/flight-log',
    '/crdt/status',
    '/crdt/files',
    '/crdt/cursors',
    '/crdt/diagnostics',
    '/crdt/annotations',
    '/crdt/emotion',
    '/crdt/participants',
    '/crdt/snapshot',
    '/crdt/state-vector',
    '/crdt/ledger',
    '/ucan/status',
    '/ucan/did',
    '/ucan/grants',
  ].map((path) => getCase(path, 503)),
  deleteCase('/logs', 200),
  ...[
    '/feedback',
    '/scaffold/create',
    '/gnot/command',
    '/code-index/search',
    '/gnosis/eval',
    '/gnosis/ts-check',
    '/gnosis/topology-graph',
    '/gnosis/autofix',
    '/edgework/exec',
    '/admin/exec',
    '/agent/session',
    '/agent/turn',
    '/agent/multi-file',
    '/agent/swarm/start',
    '/cloud-agent/start',
    '/gnosis/run',
    '/void-sync/handshake',
    '/void-sync/accept',
    '/void-sync/receive',
    '/void-sync/connect',
    '/cera/daydream/accept',
    '/cera/daydream/reject',
    '/engram/recall',
    '/engram/remember',
    '/v1/superinference/preset',
    '/agent-participant/leave',
    '/agent-participant/open',
    '/agent-participant/insert',
    '/agent-participant/delete',
    '/agent-participant/replace',
    '/agent-participant/batch-edit',
    '/agent-participant/batch-replace',
    '/agent-participant/review',
    '/agent-participant/thinking',
    '/agent-participant/undo',
    '/agent-participant/redo',
  ].map((path) => postCase(path, 400)),
  postCase(
    '/v1/chat/completions',
    200,
    {
      model: 'tinyllama-1.1b',
      messages: [{ role: 'user', content: 'hello' }],
    },
    async (response) => {
      const payload = (await response.clone().json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      expect(payload.choices?.[0]?.message?.content).toBe('mock completion');
      expect(response.headers.get('X-Zedge-Tier')).toBe('edge');
    }
  ),
  postCase('/v1/completions', 200, { prompt: 'hello' }),
  postCase('/v1/embeddings', 200, { input: 'hello' }),
  postCase('/gnot/command', 200, { action: 'files' }),
  ...[
    '/compute-pool/join',
    '/compute-pool/leave',
    '/mesh/start',
    '/mesh/stop',
    '/v1/superinference',
    '/v1/superinference/recursive',
    '/void-sync/disconnect',
    '/breeding/run',
    '/auth/login',
    '/auth/logout',
    '/cera/daydream/dream',
    '/cera/daydream/activity',
    '/phase3/wire',
    '/void-map/compact',
    '/void-map/export',
  ].map((path) => postCase(path, 200)),
  postCase('/v1/chat/completions/resilient', 200, {}, expectSse),
  postCase('/v1/binary/infer', 415, undefined, undefined),
  ...[
    '/mesh/infer',
    '/forge/deploy',
    '/vfs/mount',
    '/collab/session',
    '/collab/presence',
    '/kernel/execute',
    '/kernel/route',
    '/kernel/deep-link',
    '/capacitor/mount',
    '/capacitor/personalize',
    '/capacitor/project',
    '/capacitor/index',
    '/crdt/open',
    '/crdt/close',
    '/crdt/cursor',
    '/crdt/selection',
    '/crdt/diagnostics',
    '/crdt/annotation',
    '/crdt/reading',
    '/crdt/emotion',
    '/crdt/undo',
    '/crdt/contribute',
    '/crdt/redo',
    '/crdt/invite',
    '/crdt/join',
    '/agent-participant/join',
    '/ucan/issue',
    '/ucan/agent',
    '/ucan/invite',
    '/ucan/verify',
    '/ucan/revoke-audience',
    '/ucan/revoke-mode',
  ].map((path) => postCase(path, 503)),
  deleteCase('/engram/forget', 400),
  prefixCase(
    'DELETE /agent/session/*',
    '/agent/session/mock-session',
    'DELETE',
    200
  ),
  prefixCase(
    'GET /cloud-agent/session/*',
    '/cloud-agent/session/missing-session',
    'GET',
    404
  ),
  prefixCase(
    'GET /cloud-agent/stream/*',
    '/cloud-agent/stream/mock-session',
    'GET',
    200,
    undefined,
    expectSse
  ),
  prefixCase(
    'POST /cloud-agent/cancel/*',
    '/cloud-agent/cancel/mock-session',
    'POST',
    200,
    {}
  ),
  prefixCase('GET /forge/logs/*', '/forge/logs/mock-process', 'GET', 503),
  prefixCase('POST /forge/stop/*', '/forge/stop/mock-process', 'POST', 503, {}),
  prefixCase(
    'POST /cera/accept/*',
    '/cera/accept/mock-mutation',
    'POST',
    503,
    {}
  ),
  prefixCase(
    'POST /cera/reject/*',
    '/cera/reject/mock-mutation',
    'POST',
    503,
    {}
  ),
  prefixCase('GET /emotion/profile*', '/emotion/profile', 'GET', 400),
  prefixCase('GET /vfs/status/*', '/vfs/status/mock-mount', 'GET', 503),
  prefixCase(
    'POST /collab/join/*',
    '/collab/join/mock-session',
    'POST',
    503,
    {}
  ),
  prefixCase(
    'GET /collab/participants/*',
    '/collab/participants/mock-session',
    'GET',
    503
  ),
  prefixCase(
    'GET /capacitor/layout/*',
    '/capacitor/layout/mock-mount',
    'GET',
    503
  ),
  prefixCase(
    'GET /capacitor/graph/*',
    '/capacitor/graph/mock-mount',
    'GET',
    503
  ),
  prefixCase('POST /ucan/revoke/*', '/ucan/revoke/mock-grant', 'POST', 503, {}),
];

const skippedRoutes = new Map<string, string>([
  ['POST /restart', 'Would intentionally terminate the test process.'],
]);

describe('server route audit', () => {
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;

  beforeAll(() => {
    console.log = (() => undefined) as typeof console.log;
    console.warn = (() => undefined) as typeof console.warn;
  });

  afterAll(() => {
    mock.restore();
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
  });

  beforeEach(() => {
    resetState();
  });

  test('classifies every inline route in server.ts', () => {
    const inventory = parseRouteInventory();
    const covered = new Set([
      ...routeCases.map((routeCase) => routeCase.key),
      ...skippedRoutes.keys(),
    ]);

    const missing = Array.from(inventory).filter((key) => !covered.has(key));
    const extra = Array.from(covered).filter((key) => !inventory.has(key));

    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
    expect(inventory.size).toBe(185);
  });

  test('responds to CORS preflight before route dispatch', async () => {
    const response = await handleWebRequest(
      createRequest('/health', {
        method: 'OPTIONS',
      })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain(
      'GET'
    );
  });

  test('delegates babelfish paths through the shared babelfish handler', async () => {
    const response = await handleWebRequest(
      createRequest('/babelfish/capabilities')
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { path: string };
    expect(payload.path).toBe('/babelfish/capabilities');
  });

  test('returns 404 for unknown routes', async () => {
    const response = await handleWebRequest(createRequest('/does-not-exist'));

    expect(response.status).toBe(404);
  });

  test('converts x-gnosis payload requests into HTTP route handling', async () => {
    const payload = await zedgeControlSurface.handleRequest({
      method: 'GET',
      path: '/health',
      headers: {
        host: 'localhost:7331',
      },
      body: new Uint8Array(0),
    });

    expect(payload).not.toBeNull();
    expect(payload?.status).toBe(200);
    const json = JSON.parse(new TextDecoder().decode(payload?.body)) as {
      status: string;
    };
    expect(json.status).toBe('ok');
  });

  test('ignores aeon listener control paths on the x-gnosis surface', async () => {
    const payload = await zedgeControlSurface.handleRequest({
      method: 'GET',
      path: '/.aeon/session',
      headers: {
        host: 'localhost:7331',
      },
      body: new Uint8Array(0),
    });

    expect(payload).toBeNull();
  });

  for (const routeCase of routeCases) {
    test(routeCase.key, async () => {
      const response = await handleWebRequest(routeCase.request());
      const expectedStatuses = Array.isArray(routeCase.expectedStatus)
        ? routeCase.expectedStatus
        : [routeCase.expectedStatus];

      expect(expectedStatuses).toContain(response.status);
      if (routeCase.verify) {
        await routeCase.verify(response);
      }
    });
  }
});
