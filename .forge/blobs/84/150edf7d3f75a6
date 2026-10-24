/**
 * Zedge Kernel Bridge (Phase 4)
 *
 * Connects Zedge to the aeon-shell kernel, enabling:
 * - Kernel command execution from Zed
 * - Plugin registration via MCP bridge
 * - Daemon status monitoring
 * - Cognitive routing for task→model selection
 * - Deep link support (aeon://zedge/...)
 */

// ---------------------------------------------------------------------------
// Types (aligned with aeon-shell-core kernel types)
// ---------------------------------------------------------------------------

export interface KernelCommand {
  id: string;
  label: string;
  description: string;
  execute: (payload: unknown) => Promise<unknown>;
}

export interface KernelDaemonStatus {
  name: string;
  status: 'running' | 'stopped' | 'error';
  uptime: number;
  lastHeartbeat: number;
  metadata?: Record<string, unknown>;
}

export interface CognitiveRoute {
  taskType: string;
  recommendedModel: string;
  confidence: number;
  reasoning: string;
  adapter?: string;
}

export interface PluginRegistration {
  id: string;
  name: string;
  version: string;
  capabilities: string[];
  commands: KernelCommand[];
  registeredAt: number;
}

export interface DeepLinkRequest {
  protocol: 'aeon';
  action: string;
  params: Record<string, string>;
}

export interface FlightRecordEntry {
  timestamp: number;
  event: string;
  module: string;
  data?: Record<string, unknown>;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Cognitive routing patterns (from aeon-shell-core cognitive-router)
// ---------------------------------------------------------------------------

const TASK_MODEL_MAP: Record<
  string,
  { model: string; adapter?: string; confidence: number }
> = {
  'bug-fix': {
    model: 'qwen-2.5-coder-7b',
    adapter: 'analytical-reasoning',
    confidence: 0.9,
  },
  'code-review': {
    model: 'gemma3-4b-it',
    adapter: 'constructive-empathy',
    confidence: 0.85,
  },
  autocomplete: { model: 'tinyllama-1.1b', confidence: 0.95 },
  refactor: {
    model: 'qwen-2.5-coder-7b',
    adapter: 'analytical-formal',
    confidence: 0.88,
  },
  explain: { model: 'gemma3-4b-it', confidence: 0.82 },
  'test-write': {
    model: 'qwen-2.5-coder-7b',
    adapter: 'analytical-casual',
    confidence: 0.87,
  },
  docs: {
    model: 'gemma3-4b-it',
    adapter: 'supportive-mindful',
    confidence: 0.8,
  },
  debug: {
    model: 'qwen-2.5-coder-7b',
    adapter: 'analytical-reasoning',
    confidence: 0.92,
  },
  chat: { model: 'tinyllama-1.1b', confidence: 0.75 },
};

const DEEP_REASONING_PATTERNS = [
  /\bcompare\b/i,
  /\bcontrast\b/i,
  /\bsynthesize\b/i,
  /\bdecompose\b/i,
  /\bwhy\b/i,
  /\breason\b/i,
  /\btrade[-\s]?off\b/i,
  /\bframework\b/i,
];

// ---------------------------------------------------------------------------
// KernelBridge
// ---------------------------------------------------------------------------

export class KernelBridge {
  private commands = new Map<string, KernelCommand>();
  private daemons = new Map<string, KernelDaemonStatus>();
  private plugins = new Map<string, PluginRegistration>();
  private flightLog: FlightRecordEntry[] = [];
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
    this.registerBuiltinCommands();
    this.initDaemons();
  }

  /**
   * Register Zedge as an aeon-shell plugin.
   */
  registerPlugin(
    plugin: Omit<PluginRegistration, 'registeredAt'>
  ): PluginRegistration {
    const registration: PluginRegistration = {
      ...plugin,
      registeredAt: Date.now(),
    };
    this.plugins.set(plugin.id, registration);

    // Register plugin commands
    for (const cmd of plugin.commands) {
      this.commands.set(cmd.id, cmd);
    }

    this.record('plugin-registered', 'kernel-bridge', { pluginId: plugin.id });
    return registration;
  }

  /**
   * Execute a kernel command by ID.
   */
  async executeCommand(commandId: string, payload?: unknown): Promise<unknown> {
    const command = this.commands.get(commandId);
    if (!command) {
      throw new Error(`Kernel command not found: ${commandId}`);
    }

    const start = Date.now();
    try {
      const result = await command.execute(payload);
      this.record('command-executed', 'kernel-bridge', {
        commandId,
        durationMs: Date.now() - start,
      });
      return result;
    } catch (err) {
      this.record('command-failed', 'kernel-bridge', {
        commandId,
        error: String(err),
      });
      throw err;
    }
  }

  /**
   * Route a task to the best-fit inference model.
   */
  routeTask(taskDescription: string, taskType?: string): CognitiveRoute {
    // Direct mapping if task type provided
    if (taskType && TASK_MODEL_MAP[taskType]) {
      const mapping = TASK_MODEL_MAP[taskType]!;
      return {
        taskType,
        recommendedModel: mapping.model,
        confidence: mapping.confidence,
        reasoning: `Direct mapping for task type: ${taskType}`,
        adapter: mapping.adapter,
      };
    }

    // Infer task type from description
    const inferred = this.inferTaskType(taskDescription);
    const mapping = TASK_MODEL_MAP[inferred.type] ?? TASK_MODEL_MAP['chat']!;

    return {
      taskType: inferred.type,
      recommendedModel: mapping.model,
      confidence: mapping.confidence * inferred.confidence,
      reasoning: inferred.reasoning,
      adapter: mapping.adapter,
    };
  }

  /**
   * Get all registered commands.
   */
  listCommands(): KernelCommand[] {
    return Array.from(this.commands.values());
  }

  /**
   * Get daemon statuses.
   */
  getDaemonStatus(): KernelDaemonStatus[] {
    return Array.from(this.daemons.values());
  }

  /**
   * Get registered plugins.
   */
  getPlugins(): PluginRegistration[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Parse and handle a deep link.
   */
  parseDeepLink(url: string): DeepLinkRequest | null {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'aeon:') return null;

      const action = parsed.pathname.replace(/^\/+/, '');
      const params: Record<string, string> = {};
      for (const [key, value] of parsed.searchParams) {
        params[key] = value;
      }

      return { protocol: 'aeon', action, params };
    } catch {
      return null;
    }
  }

  /**
   * Get flight recorder entries.
   */
  getFlightLog(limit = 50): FlightRecordEntry[] {
    return this.flightLog.slice(-limit);
  }

  /**
   * Record a flight log entry.
   */
  record(
    event: string,
    module: string,
    data?: Record<string, unknown>,
    durationMs?: number
  ): void {
    this.flightLog.push({
      timestamp: Date.now(),
      event,
      module,
      data,
      durationMs,
    });
    // Keep log bounded
    if (this.flightLog.length > 1000) {
      this.flightLog = this.flightLog.slice(-500);
    }
  }

  private inferTaskType(description: string): {
    type: string;
    confidence: number;
    reasoning: string;
  } {
    const lower = description.toLowerCase();

    if (/\bfix\b|\bbug\b|\berror\b|\bcrash\b/.test(lower)) {
      return {
        type: 'bug-fix',
        confidence: 0.85,
        reasoning: 'Contains bug/fix/error keywords',
      };
    }
    if (/\breview\b|\bfeedback\b|\bpr\b/.test(lower)) {
      return {
        type: 'code-review',
        confidence: 0.8,
        reasoning: 'Contains review/feedback keywords',
      };
    }
    if (/\brefactor\b|\bclean\b|\brestructure\b/.test(lower)) {
      return {
        type: 'refactor',
        confidence: 0.85,
        reasoning: 'Contains refactor keywords',
      };
    }
    if (/\btest\b|\bspec\b|\bassert\b/.test(lower)) {
      return {
        type: 'test-write',
        confidence: 0.82,
        reasoning: 'Contains test/spec keywords',
      };
    }
    if (/\bexplain\b|\bwhat\b|\bhow\b/.test(lower)) {
      return {
        type: 'explain',
        confidence: 0.75,
        reasoning: 'Contains explanation keywords',
      };
    }
    if (/\bdoc\b|\bcomment\b|\breadme\b/.test(lower)) {
      return {
        type: 'docs',
        confidence: 0.78,
        reasoning: 'Contains documentation keywords',
      };
    }
    if (/\bdebug\b|\btrace\b|\binspect\b/.test(lower)) {
      return {
        type: 'debug',
        confidence: 0.88,
        reasoning: 'Contains debug keywords',
      };
    }
    if (/\bcomplete\b|\bsuggest\b|\bauto\b/.test(lower)) {
      return {
        type: 'autocomplete',
        confidence: 0.9,
        reasoning: 'Contains autocomplete keywords',
      };
    }

    // Check for deep reasoning patterns
    const needsDeepReasoning = DEEP_REASONING_PATTERNS.some((p) =>
      p.test(description)
    );
    if (needsDeepReasoning) {
      return {
        type: 'explain',
        confidence: 0.7,
        reasoning: 'Deep reasoning pattern detected',
      };
    }

    return {
      type: 'chat',
      confidence: 0.5,
      reasoning: 'No specific task type detected, defaulting to chat',
    };
  }

  private registerBuiltinCommands(): void {
    const builtins: KernelCommand[] = [
      {
        id: 'aeon:deploy',
        label: 'Deploy',
        description: 'Trigger ForgoCD deploy for current workspace',
        execute: async () => ({ status: 'deploy-triggered' }),
      },
      {
        id: 'aeon:mesh-status',
        label: 'Mesh Status',
        description: 'Get P2P mesh status',
        execute: async () => ({ status: 'ok' }),
      },
      {
        id: 'aeon:inference',
        label: 'Inference',
        description: 'Run inference via cognitive router',
        execute: async (payload) => this.routeTask(String(payload ?? '')),
      },
      {
        id: 'aeon:health',
        label: 'Health Check',
        description: 'Check overall system health',
        execute: async () => ({
          uptime: Date.now() - this.startTime,
          daemons: this.getDaemonStatus().map((d) => ({
            name: d.name,
            status: d.status,
          })),
          plugins: this.getPlugins().length,
          commands: this.commands.size,
        }),
      },
    ];

    for (const cmd of builtins) {
      this.commands.set(cmd.id, cmd);
    }
  }

  private initDaemons(): void {
    const daemonNames = ['learning', 'presence', 'graph', 'reranker'];
    for (const name of daemonNames) {
      this.daemons.set(name, {
        name,
        status: 'stopped',
        uptime: 0,
        lastHeartbeat: 0,
      });
    }
  }
}
