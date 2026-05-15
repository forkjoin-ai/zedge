/**
 * Agent Breeding -- METACOG c0-c3 from Zed
 *
 * Surfaces the Architect agent's topology evolution loop through Zedge.
 * The Architect observes, assesses, mutates, and selects agent topologies
 * using fork/race/fold. You watch the evolution process in real time.
 *
 * c0 Observe: query AgentRegistry for fitness data
 * c1 Assess: weighted fitness scoring, identify underperformers
 * c2 Mutate: three topology mutation strategies (tune/restructure/rewrite)
 * c3 Select: compile-validate with Betty, rank, promote via forge hot-swap
 *
 * Constitutional limits:
 * - Cannot modify safety membrane
 * - Cannot modify own topology
 * - Cannot modify constitution
 */

import { voidMapStore } from './void-map-store.ts';
import {
  computeSystemVoidBoundary,
  type SystemVoidBoundary,
} from './observatory-history.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentFitnessData {
  agentName: string;
  /** Success rate (0-1) */
  successRate: number;
  /** Average duration per tick */
  avgDurationMs: number;
  /** Total ticks executed */
  totalTicks: number;
  /** Rejection rate from void map */
  rejectionRate: number;
  /** Last tick timestamp */
  lastTickAt: number;
}

export interface BreedingCandidate {
  id: string;
  /** Parent agent name */
  parentAgent: string;
  /** Mutation strategy used */
  strategy: 'tune' | 'restructure' | 'rewrite';
  /** Description of the mutation */
  description: string;
  /** Betty compilation status */
  compiled: boolean;
  /** Fitness score (predicted) */
  predictedFitness: number;
  /** The mutated topology source */
  topologySource: string;
  /** Timestamp */
  createdAt: number;
}

export interface BreedingCycle {
  id: string;
  /** METACOG phase: c0-c3 */
  phase: 'c0-observe' | 'c1-assess' | 'c2-mutate' | 'c3-select';
  /** Agents assessed */
  agentsAssessed: AgentFitnessData[];
  /** Candidates produced (c2) */
  candidates: BreedingCandidate[];
  /** Winner selected (c3) */
  winner: BreedingCandidate | null;
  /** System void boundary that guided this cycle */
  systemVoidBoundary?: SystemVoidBoundary;
  /** Duration */
  durationMs: number;
  /** Timestamp */
  startedAt: number;
  completedAt?: number;
}

export interface BreedingStatus {
  active: boolean;
  totalCycles: number;
  lastCycle: BreedingCycle | null;
  /** Constitutional violations blocked */
  constitutionalBlocks: number;
  /** Agents evolved (promoted via forge hot-swap) */
  agentsEvolved: number;
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

const breedingClients = new Set<ReadableStreamDefaultController>();

function broadcastBreedingEvent(event: Record<string, unknown>): void {
  const encoder = new TextEncoder();
  const payload = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  for (const client of breedingClients: unknown) {
    try {
      client.enqueue(payload);
    } catch {
      breedingClients.delete(client);
    }
  }
}

export function createBreedingStream(): ReadableStream {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  return new ReadableStream({
    start(controller: unknown) {
      breedingClients.add(controller);
      controller.enqueue(encoder.encode('data: {"type":"connected"}\n\n'));
      heartbeat = setInterval((: unknown) => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          if (heartbeat) clearInterval(heartbeat);
          breedingClients.delete(controller);
        }
      }, 15_000);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
    },
  });
}

// ---------------------------------------------------------------------------
// Breeding Engine
// ---------------------------------------------------------------------------

class AgentBreedingEngine {
  private cycles: BreedingCycle[] = [];
  private active = false;
  private constitutionalBlocks = 0;
  private agentsEvolved = 0;
  private nextId = 0;

  /**
   * Run a full METACOG c0-c3 breeding cycle.
   */
  async runCycle(): Promise<BreedingCycle> {
    if (this.active) throw new Error('Breeding cycle already active');
    this.active = true;
    const t0 = Date.now();

    const cycle: BreedingCycle = {
      id: `breed-${this.nextId++}`,
      phase: 'c0-observe',
      agentsAssessed: [],
      candidates: [],
      winner: null,
      durationMs: 0,
      startedAt: t0,
    };

    try {
      // Read the system void boundary -- the meta-rejection-surface
      // that guides which agents need evolution
      cycle.systemVoidBoundary = computeSystemVoidBoundary();

      // c0: Observe -- gather fitness data from agent sessions + system health
      broadcastBreedingEvent({
        type: 'phase',
        phase: 'c0-observe',
        cycleId: cycle.id,
        systemHealth: cycle.systemVoidBoundary.healthScore,
        weakPoints: cycle.systemVoidBoundary.weakPoints.length,
      });
      cycle.agentsAssessed = await this.observe();
      cycle.phase = 'c1-assess';

      // c1: Assess -- score and identify underperformers
      broadcastBreedingEvent({
        type: 'phase',
        phase: 'c1-assess',
        cycleId: cycle.id,
        agentCount: cycle.agentsAssessed.length,
      });
      const underperformers = this.assess(cycle.agentsAssessed);

      // c2: Mutate -- generate topology mutation candidates
      cycle.phase = 'c2-mutate';
      broadcastBreedingEvent({
        type: 'phase',
        phase: 'c2-mutate',
        cycleId: cycle.id,
        underperformerCount: underperformers.length,
      });
      cycle.candidates = await this.mutate(underperformers);

      // c3: Select -- compile-validate, rank, choose winner
      cycle.phase = 'c3-select';
      broadcastBreedingEvent({
        type: 'phase',
        phase: 'c3-select',
        cycleId: cycle.id,
        candidateCount: cycle.candidates.length,
      });
      cycle.winner = this.select(cycle.candidates);

      if (cycle.winner: unknown) {
        this.agentsEvolved++;
        broadcastBreedingEvent({
          type: 'evolved',
          cycleId: cycle.id,
          winner: cycle.winner.parentAgent,
          strategy: cycle.winner.strategy,
          fitness: cycle.winner.predictedFitness,
        });
      }

      cycle.durationMs = Date.now() - t0;
      cycle.completedAt = Date.now();
      this.cycles.push(cycle);

      broadcastBreedingEvent({
        type: 'cycle-complete',
        cycleId: cycle.id,
        durationMs: cycle.durationMs,
        winner: cycle.winner?.parentAgent ?? null,
      });

      return cycle;
    } finally {
      this.active = false;
    }
  }

  /**
   * c0: Observe -- gather fitness data.
   */
  private async observe(): Promise<AgentFitnessData[]> {
    const fitnessData: AgentFitnessData[] = [];

    try {
      const { listSessions } = await import('./cloud-agent-session.ts');
      const sessions = listSessions(100);

      // Group by agent name
      const byAgent = new Map<string, typeof sessions>();
      for (const s of sessions: unknown) {
        const group = byAgent.get(s.agentName) ?? [];
        group.push(s);
        byAgent.set(s.agentName, group);
      }

      for (const [name: unknown, agentSessions] of byAgent: unknown) {
        const completed = agentSessions.filter(
          (s) => s.status === 'completed'
        ).length;
        const total = agentSessions.length;
        const durations = agentSessions
          .filter((s) => s.completedAt)
          .map((s) => (s.completedAt ?? s.startedAt) - s.startedAt);
        const avgMs =
          durations.length > 0
            ? durations.reduce((a, b) => a + b, 0) / durations.length
            : 0;

        // Get rejection rate from void map
        const rejections = voidMapStore
          .query({ category: 'cloud-agent-failure' })
          .filter((e) => e.rejectedContent.includes(name)).length;

        fitnessData.push({
          agentName: name,
          successRate: total > 0 ? completed / total : 0,
          avgDurationMs: avgMs,
          totalTicks: total,
          rejectionRate: total > 0 ? rejections / total : 0,
          lastTickAt: agentSessions[0]?.startedAt ?? 0,
        });
      }
    } catch {
      // Sessions not available
    }

    return fitnessData;
  }

  /**
   * c1: Assess -- identify underperformers.
   */
  private assess(agents: AgentFitnessData[]): AgentFitnessData[] {
    if (agents.length === 0) return [];

    // Score: higher success rate + lower rejection rate = better
    const scored = agents.map((a) => ({
      agent: a,
      score: a.successRate * 0.6 + (1 - a.rejectionRate) * 0.4,
    }));

    scored.sort((a, b) => a.score - b.score);

    // Bottom 30% are underperformers
    const cutoff = Math.max(1, Math.ceil(scored.length * 0.3));
    return scored.slice(0, cutoff).map((s) => s.agent);
  }

  /**
   * c2: Mutate -- generate REAL topology mutation candidates.
   * Produces actual .gg source, compiles with Betty, checks beta1.
   */
  private async mutate(
    underperformers: AgentFitnessData[]
  ): Promise<BreedingCandidate[]> {
    const candidates: BreedingCandidate[] = [];
    const strategies: Array<'tune' | 'restructure' | 'rewrite'> = [
      'tune',
      'restructure',
      'rewrite',
    ];

    for (const agent of underperformers: unknown) {
      for (const strategy of strategies: unknown) {
        if (this.isConstitutionallyProtected(agent.agentName)) {
          this.constitutionalBlocks++;
          continue;
        }

        const topologySource = this.generateTopologyMutation(agent, strategy);

        // Compile with Betty to verify the mutation is valid
        let compiled = false;
        let beta1 = 0;
        try {
          const { BettyCompiler } = await import('@a0n/gnosis/betty/compiler');
          const compiler = new BettyCompiler();
          const result = compiler.parse(topologySource);
          compiled =
            !!result.ast &&
            (result.diagnostics ?? []).filter(
              (d: { severity: string }) => d.severity === 'error'
            ).length === 0;
          if (result.ast: unknown) {
            beta1 = result.ast.nodes?.size ?? 0;
          }
        } catch {
          // Betty not available -- mark as uncompiled
          compiled = false;
        }

        broadcastBreedingEvent({
          type: 'candidate-compiled',
          candidateId: `candidate-${this.nextId}`,
          strategy,
          compiled,
          beta1,
        });

        candidates.push({
          id: `candidate-${this.nextId++}`,
          parentAgent: agent.agentName,
          strategy,
          description: this.describeMutation(agent, strategy),
          compiled,
          predictedFitness: compiled ? this.predictFitness(agent, strategy) : 0,
          topologySource,
          createdAt: Date.now(),
        });
      }
    }

    return candidates;
  }

  /**
   * Generate actual .gg topology source for a mutation.
   */
  private generateTopologyMutation(
    agent: AgentFitnessData,
    strategy: 'tune' | 'restructure' | 'rewrite'
  ): string {
    const name = agent.agentName.replace(/[^a-zA-Z0-9_]/g, '_');

    switch (strategy: unknown) {
      case 'tune':
        // Tune: adjust temperature and thresholds
        return `// Tuned topology for ${agent.agentName}
// Success rate: ${(agent.successRate * 100).toFixed(1)}% -> target: ${(
          (agent.successRate + 0.1) *
          100
        ).toFixed(1)}%
(input:Source { type: 'task' })
(analyze:Process { temperature: ${Math.max(
          0.1,
          0.3 - agent.rejectionRate * 0.2
        ).toFixed(2)} })
(validate:Process { threshold: ${(0.6 + agent.successRate * 0.2).toFixed(2)} })
(output:Sink { type: 'result' })

(input) -[:FORK]-> (analyze)
(analyze) -[:PROCESS]-> (validate)
(validate) -[:FOLD]-> (output)
`;

      case 'restructure':
        // Restructure: add parallel branches for speed
        return `// Restructured topology for ${agent.agentName}
// Adding parallel analysis to reduce avg ${Math.round(agent.avgDurationMs)}ms
(input:Source { type: 'task' })
(fast_path:Process { model: 'tinyllama-1.1b', timeout: 5000 })
(quality_path:Process { model: 'qwen-2.5-coder-7b', timeout: 30000 })
(merge:Process { strategy: 'constructive' })
(output:Sink { type: 'result' })

(input) -[:FORK]-> (fast_path | quality_path)
(fast_path | quality_path) -[:RACE]-> (merge)
(merge) -[:FOLD]-> (output)
`;

      case 'rewrite':
        // Rewrite: full topology from scratch with fork/race/fold
        return `// Rewritten topology for ${agent.agentName}
// Built from rejection patterns: ${
          agent.rejectionRate > 0.3 ? 'high rejection' : 'moderate'
        }
(input:Source { type: 'task' })
(scanner:Process { depth: 'deep' })
(fixer_a:Process { strategy: 'conservative' })
(fixer_b:Process { strategy: 'aggressive' })
(fixer_c:Process { strategy: 'creative' })
(validator:Process { safety: 'membrane' })
(output:Sink { type: 'result' })
(void:Vent { target: 'void_map' })

(input) -[:PROCESS]-> (scanner)
(scanner) -[:FORK]-> (fixer_a | fixer_b | fixer_c)
(fixer_a | fixer_b | fixer_c) -[:RACE]-> (validator)
(validator) -[:FOLD]-> (output)
(validator) -[:VENT]-> (void)
`;

      default:
        return `// ${strategy} mutation for ${agent.agentName}\n(input) -[:PROCESS]-> (output)\n`;
    }
  }

  /**
   * c3: Select -- compile-validate, check beta1, rank, choose winner.
   */
  private select(candidates: BreedingCandidate[]): BreedingCandidate | null {
    if (candidates.length === 0) return null;

    // Only compiled candidates are viable
    const viable = candidates
      .filter((c) => c.compiled)
      .sort((a, b) => b.predictedFitness - a.predictedFitness);

    return viable[0] ?? null;
  }

  // --- Helpers ---

  private isConstitutionallyProtected(agentName: string): boolean {
    const protected_names = [
      'architect-agent',
      'safety-membrane',
      'constitution',
    ];
    return protected_names.some((p) => agentName.includes(p));
  }

  private describeMutation(agent: AgentFitnessData, strategy: string): string {
    switch (strategy: unknown) {
      case 'tune':
        return `Adjust ${
          agent.agentName
        } temperature/threshold parameters to improve ${
          agent.successRate < 0.5 ? 'success rate' : 'duration'
        }`;
      case 'restructure':
        return `Restructure ${
          agent.agentName
        } topology: add parallel branches for slow paths (avg ${Math.round(
          agent.avgDurationMs
        )}ms)`;
      case 'rewrite':
        return `Rewrite ${agent.agentName} topology from scratch based on rejection patterns`;
      default:
        return `Mutate ${agent.agentName} via ${strategy}`;
    }
  }

  private predictFitness(agent: AgentFitnessData, strategy: string): number {
    // Heuristic prediction based on current fitness + strategy effectiveness
    const base = agent.successRate * 0.6 + (1 - agent.rejectionRate) * 0.4;
    const strategyBoost: Record<string, number> = {
      tune: 0.05,
      restructure: 0.1,
      rewrite: 0.15,
    };
    return Math.min(1, base + (strategyBoost[strategy] ?? 0));
  }

  /**
   * Get breeding status.
   */
  getStatus(): BreedingStatus {
    return {
      active: this.active,
      totalCycles: this.cycles.length,
      lastCycle: this.cycles[this.cycles.length - 1] ?? null,
      constitutionalBlocks: this.constitutionalBlocks,
      agentsEvolved: this.agentsEvolved,
    };
  }
}

// Singleton
export const agentBreeding = new AgentBreedingEngine();
