/**
 * Agent Swarm -- Multi-Agent Orchestration
 *
 * Manages multiple concurrent AgentParticipants with different roles.
 * Each agent is a first-class CRDT participant with visible cursors,
 * individually undoable edits, and UCAN-scoped permissions.
 *
 * The reviewer flags a line, the refactorer acts on it.
 * You watch them work in real time.
 */

import { AgentParticipant, type AgentParticipantConfig } from './agent-participant';
import { getRole, listRoles, type AgentRole } from './agent-roles';
import type { CrdtBridge } from './crdt-bridge';
import type { UcanBridge } from './ucan-bridge';
import { voidMapStore } from './void-map-store';
import { superinfer } from './superinference';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SwarmConfig {
  /** Task description -- what the swarm should accomplish */
  task: string;
  /** Roles to activate (e.g. ['reviewer', 'refactorer']) */
  roles: string[];
  /** Target files (optional -- all open files if omitted) */
  targetFiles?: string[];
}

export interface SwarmAgent {
  roleId: string;
  role: AgentRole;
  participant: AgentParticipant;
  status: 'idle' | 'working' | 'done' | 'error';
  result?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface SwarmStatus {
  active: boolean;
  task: string;
  agents: Array<{
    roleId: string;
    displayName: string;
    status: string;
    model: string;
    color: string;
    durationMs?: number;
  }>;
  startedAt: number;
  completedAt?: number;
}

export interface SwarmResult {
  task: string;
  agents: Array<{
    roleId: string;
    status: string;
    result?: string;
    error?: string;
    durationMs: number;
  }>;
  totalDurationMs: number;
}

// ---------------------------------------------------------------------------
// Agent Swarm
// ---------------------------------------------------------------------------

export class AgentSwarm {
  private agents = new Map<string, SwarmAgent>();
  private active = false;
  private task = '';
  private startedAt = 0;
  private completedAt?: number;
  private crdtBridge: CrdtBridge;
  private ucanBridge: UcanBridge | null;
  private taskCompletion: Promise<PromiseSettledResult<void>[]> | null = null;

  constructor(crdtBridge: CrdtBridge, ucanBridge?: UcanBridge) {
    this.crdtBridge = crdtBridge;
    this.ucanBridge = ucanBridge ?? null;
  }

  /**
   * Start the swarm -- fork task into role-appropriate sub-tasks.
   */
  async start(config: SwarmConfig): Promise<SwarmStatus> {
    if (this.active) {
      throw new Error('Swarm already active. Stop it first.');
    }

    this.task = config.task;
    this.startedAt = Date.now();
    this.active = true;
    this.agents.clear();
    this.completedAt = undefined;

    // Create an agent for each requested role
    for (const roleId of config.roles) {
      const role = getRole(roleId);
      if (!role) continue;

      const participantConfig: AgentParticipantConfig = {
        agentId: `swarm-${role.id}`,
        displayName: `${role.displayName} (Swarm)`,
        model: role.preferredModel,
        color: role.color,
        mode: role.mode,
      };

      const participant = new AgentParticipant(
        participantConfig,
        this.crdtBridge,
        this.ucanBridge ?? undefined
      );

      const swarmAgent: SwarmAgent = {
        roleId,
        role,
        participant,
        status: 'idle',
        startedAt: Date.now(),
      };

      this.agents.set(roleId, swarmAgent);
    }

    // Join all agents to the workspace
    const joinPromises = [...this.agents.values()].map(async (agent) => {
      try {
        await agent.participant.join();
        agent.status = 'working';
      } catch (err) {
        agent.status = 'error';
        agent.error = err instanceof Error ? err.message : String(err);
      }
    });

    await Promise.all(joinPromises);

    // Open target files for each agent
    if (config.targetFiles) {
      for (const agent of this.agents.values()) {
        if (agent.status !== 'working') continue;
        for (const file of config.targetFiles) {
          try {
            await agent.participant.openFile(file);
          } catch {
            // File may not be available
          }
        }
      }
    }

    // Execute tasks through superinference for each agent
    const steering = config.targetFiles?.[0]
      ? voidMapStore.getSteeringVector(config.targetFiles[0])
      : voidMapStore.getSteeringVector();

    const taskPromises = [...this.agents.values()]
      .filter((a) => a.status === 'working')
      .map((a) => this.executeAgentTask(a, config.task, config.targetFiles, steering.negativePrompt));

    // Fire and don't block -- collapse() waits for completion
    this.taskCompletion = Promise.allSettled(taskPromises);

    return this.getStatus();
  }

  /**
   * Execute a task for a single agent through superinference.
   */
  private async executeAgentTask(
    agent: SwarmAgent,
    task: string,
    targetFiles?: string[],
    steeringOverrides?: string
  ): Promise<void> {
    try {
      // Read target file contents for context
      let fileContext = '';
      if (targetFiles) {
        const workspacePath = process.env.AEON_ROOT || process.cwd();
        for (const file of targetFiles.slice(0, 3)) {
          try {
            const content = readFileSync(resolve(workspacePath, file), 'utf-8');
            fileContext += `\n--- ${file} ---\n${content.slice(0, 4000)}\n`;
          } catch {
            // File may not exist
          }
        }
      }

      const result = await superinfer({
        request: {
          model: agent.role.preferredModel,
          messages: [
            { role: 'system', content: agent.role.systemPrompt },
            {
              role: 'user',
              content: `Task: ${task}${fileContext ? `\n\nCode context:${fileContext}` : ''}`,
            },
          ],
          temperature: 0.3,
          max_tokens: 2048,
        },
        models: [agent.role.preferredModel],
        strategy: agent.role.strategy,
        steeringOverrides: steeringOverrides || undefined,
      });

      agent.result = result.content;
      agent.status = 'done';
      agent.finishedAt = Date.now();
    } catch (err) {
      agent.error = err instanceof Error ? err.message : String(err);
      agent.status = 'error';
      agent.finishedAt = Date.now();
    }
  }

  /**
   * Wait for all agents to finish and return unified results.
   */
  async collapse(): Promise<SwarmResult> {
    // Wait for task execution to complete
    if (this.taskCompletion) {
      await this.taskCompletion;
      this.taskCompletion = null;
    }

    // Leave all agents
    for (const agent of this.agents.values()) {
      try {
        await agent.participant.leave();
        if (agent.status === 'working') {
          agent.status = 'done';
        }
        agent.finishedAt = Date.now();
      } catch {
        agent.status = 'error';
        agent.finishedAt = Date.now();
      }
    }

    this.completedAt = Date.now();
    this.active = false;

    return {
      task: this.task,
      agents: [...this.agents.values()].map((a) => ({
        roleId: a.roleId,
        status: a.status,
        result: a.result,
        error: a.error,
        durationMs: (a.finishedAt ?? Date.now()) - a.startedAt,
      })),
      totalDurationMs: this.completedAt - this.startedAt,
    };
  }

  /**
   * Stop the swarm immediately.
   */
  async stop(): Promise<void> {
    for (const agent of this.agents.values()) {
      try {
        await agent.participant.leave();
      } catch {
        // Best effort
      }
      agent.status = agent.status === 'working' ? 'done' : agent.status;
      agent.finishedAt = Date.now();
    }

    this.completedAt = Date.now();
    this.active = false;
  }

  /**
   * Get the current status of all agents.
   */
  getStatus(): SwarmStatus {
    return {
      active: this.active,
      task: this.task,
      agents: [...this.agents.values()].map((a) => ({
        roleId: a.roleId,
        displayName: a.role.displayName,
        status: a.status,
        model: a.role.preferredModel,
        color: a.role.color,
        durationMs: a.finishedAt
          ? a.finishedAt - a.startedAt
          : this.active
            ? Date.now() - a.startedAt
            : undefined,
      })),
      startedAt: this.startedAt,
      completedAt: this.completedAt,
    };
  }

  /**
   * Get a specific agent by role.
   */
  getAgent(roleId: string): SwarmAgent | undefined {
    return this.agents.get(roleId);
  }

  /**
   * List available roles.
   */
  static listRoles(): string[] {
    return listRoles();
  }

  /**
   * Check if the swarm is currently active.
   */
  get isActive(): boolean {
    return this.active;
  }
}
