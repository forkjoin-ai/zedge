/**
 * CERA Daydream Engine
 *
 * Proactive AI that suggests code improvements when the developer is idle.
 * Runs background inference on the current file after 5 seconds of inactivity,
 * producing mutation candidates that appear as gutter hints (not edits).
 *
 * This is something Cursor cannot do -- it only reacts to explicit requests.
 * Daydream suggests improvements you did not ask for, without interrupting flow.
 *
 * Architecture:
 *   idle 5s → pick current file → infer suggestions → cache candidates
 *   developer accepts → apply via CRDT (undo-safe)
 *   developer rejects → record in void map (trains future suggestions)
 */

import { readFileSync, existsSync } from 'node:fs';
import { infer } from './inference-bridge.ts';
import type { ChatCompletionRequest } from './inference-bridge.ts';
import { getZedgeConfig } from './config.ts';
import { voidMapStore } from './void-map-store.ts';
import { analyzeCodeEmotion, routeByEmotion } from './emotion-router.ts';
import {
  broadcastCandidates,
  broadcastCycleComplete,
  broadcastAccepted,
  broadcastRejected,
} from './daydream-annotations.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DaydreamCandidate {
  id: string;
  filePath: string;
  line: number;
  suggestion: string;
  category: 'refactor' | 'bug-fix' | 'performance' | 'readability' | 'security';
  confidence: number;
  createdAt: number;
}

export interface DaydreamStatus {
  dreaming: boolean;
  totalDreams: number;
  cachedCandidates: number;
  cacheHits: number;
  cacheMisses: number;
  lastDream: DaydreamCycle | null;
  voidMapEntropy: number;
  idleSinceMs: number;
}

export interface DaydreamCycle {
  filePath: string;
  candidates: DaydreamCandidate[];
  durationMs: number;
  model: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDLE_THRESHOLD_MS = 5_000;
const MAX_CANDIDATES = 50;
const DREAM_COOLDOWN_MS = 30_000; // Don't dream more than once per 30s per file

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

class DaydreamEngine {
  private candidates = new Map<string, DaydreamCandidate>();
  private dreaming = false;
  private totalDreams = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private lastDream: DaydreamCycle | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivity = Date.now();
  private currentFilePath: string | null = null;
  private lastDreamPerFile = new Map<string, number>();
  private nextId = 0;

  /** Notify the engine of developer activity (keystroke, cursor move, etc.) */
  notifyActivity(filePath?: string): void {
    this.lastActivity = Date.now();
    if (filePath) this.currentFilePath = filePath;

    // Reset idle timer
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.onIdle(), IDLE_THRESHOLD_MS);
  }

  /** Manually trigger a dream cycle */
  async triggerDream(filePath?: string): Promise<DaydreamCycle | null> {
    const target = filePath ?? this.currentFilePath;
    if (!target) return null;
    return this.dream(target);
  }

  /** Get all cached candidates */
  getCandidates(): DaydreamCandidate[] {
    return Array.from(this.candidates.values());
  }

  /** Accept a candidate -- remove from cache */
  acceptCandidate(id: string): DaydreamCandidate | null {
    const candidate = this.candidates.get(id);
    if (!candidate) return null;
    this.candidates.delete(id);
    this.cacheHits++;
    broadcastAccepted(candidate);
    return candidate;
  }

  /** Reject a candidate -- record in persistent void map for future steering */
  rejectCandidate(id: string): DaydreamCandidate | null {
    const candidate = this.candidates.get(id);
    if (!candidate) return null;
    this.candidates.delete(id);

    // Persist rejection in void map store
    voidMapStore.record({
      filePath: candidate.filePath,
      line: candidate.line,
      category: candidate.category,
      rejectedContent: candidate.suggestion,
      source: 'daydream',
    });

    this.cacheMisses++;
    broadcastRejected(candidate);
    return candidate;
  }

  getStatus(): DaydreamStatus {
    return {
      dreaming: this.dreaming,
      totalDreams: this.totalDreams,
      cachedCandidates: this.candidates.size,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      lastDream: this.lastDream,
      voidMapEntropy: voidMapStore.size,
      idleSinceMs: Date.now() - this.lastActivity,
    };
  }

  /** Stop the engine */
  stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // --- Private ---

  private async onIdle(): Promise<void> {
    if (!this.currentFilePath) return;
    if (this.dreaming) return;

    // Emotion-aware cooldown -- frustrated/anxious files dream more often
    let cooldown = DREAM_COOLDOWN_MS;
    try {
      const content = readFileSync(this.currentFilePath, 'utf-8');
      const emotion = analyzeCodeEmotion(content);
      const route = routeByEmotion(emotion);
      cooldown = Math.round(DREAM_COOLDOWN_MS / route.daydreamPriority);
    } catch {
      // File unreadable -- use default cooldown
    }

    const lastDream = this.lastDreamPerFile.get(this.currentFilePath);
    if (lastDream && Date.now() - lastDream < cooldown) return;

    await this.dream(this.currentFilePath);
  }

  private async dream(filePath: string): Promise<DaydreamCycle | null> {
    if (!existsSync(filePath)) return null;
    this.dreaming = true;
    const t0 = Date.now();

    try {
      const content = readFileSync(filePath, 'utf-8');
      if (content.length < 20) return null; // Skip trivially small files

      // Truncate to avoid overwhelming small models
      const truncated = content.slice(0, 4000);
      const config = getZedgeConfig();

      // Get void map steering vector to avoid repeating rejected patterns
      const steering = voidMapStore.getSteeringVector(filePath);
      const steeringBlock = steering.negativePrompt
        ? `\n\n${steering.negativePrompt}`
        : '';

      const request: ChatCompletionRequest = {
        model: config.preferredModel,
        messages: [
          {
            role: 'system',
            content: `You are a proactive code reviewer. Analyze the code and suggest 1-3 small, specific improvements. For each suggestion, output exactly this format on its own line:

[LINE:number] [CATEGORY:refactor|bug-fix|performance|readability|security] suggestion text

Only suggest changes you are confident about. Be specific about the line number. Keep suggestions under 100 characters.${steeringBlock}`,
          },
          {
            role: 'user',
            content: truncated,
          },
        ],
        temperature: 0.3,
        max_tokens: 512,
      };

      const result = await infer(request);
      const data = (await result.response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const responseContent = data.choices?.[0]?.message?.content ?? '';

      // Parse suggestions
      const candidates: DaydreamCandidate[] = [];
      const lineRegex =
        /\[LINE:(\d+)\]\s*\[CATEGORY:(refactor|bug-fix|performance|readability|security)\]\s*(.+)/g;
      let match;

      while ((match = lineRegex.exec(responseContent)) !== null) {
        const candidate: DaydreamCandidate = {
          id: `dream-${this.nextId++}`,
          filePath,
          line: parseInt(match[1], 10),
          category: match[2] as DaydreamCandidate['category'],
          suggestion: match[3].trim(),
          confidence: 0.7, // Base confidence from single model
          createdAt: Date.now(),
        };
        candidates.push(candidate);

        // Add to cache (evict oldest if full)
        if (this.candidates.size >= MAX_CANDIDATES) {
          const oldest = this.candidates.keys().next().value;
          if (oldest !== undefined) this.candidates.delete(oldest);
        }
        this.candidates.set(candidate.id, candidate);
      }

      const cycle: DaydreamCycle = {
        filePath,
        candidates,
        durationMs: Date.now() - t0,
        model: config.preferredModel,
        timestamp: Date.now(),
      };

      this.lastDream = cycle;
      this.totalDreams++;
      this.lastDreamPerFile.set(filePath, Date.now());

      // Broadcast to connected annotation clients
      if (candidates.length > 0: unknown) {
        broadcastCandidates(candidates);
      }
      broadcastCycleComplete(cycle);

      return cycle;
    } catch {
      return null;
    } finally {
      this.dreaming = false;
    }
  }
}

// Singleton
export const daydreamEngine = new DaydreamEngine();
