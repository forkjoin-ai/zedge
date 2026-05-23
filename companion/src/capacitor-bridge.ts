/**
 * Zedge Capacitor Bridge (Phase 5)
 *
 * Integrates aeon-flux-capacitor's DualIndex + ContentKnapsack
 * to make code blocks alive — emotionally indexed, cognitively weighted,
 * and personalized per developer.
 *
 * Key concepts from aeon-flux-capacitor:
 * - DualIndex: Amygdala (emotional tagging) + Hippocampus (semantic context)
 * - ContentKnapsack: layout solver maximizing information value in viewport
 * - Projections: text, audio, spatial, reading
 * - ESI: edge-side personalization per reader
 */

// ---------------------------------------------------------------------------
// Types (aligned with aeon-flux-capacitor types)
// ---------------------------------------------------------------------------

export interface AmygdalaTag {
  blockId: string;
  emotion: string;
  valence: number;
  arousal: number;
  dominance: number;
  intensity: number;
  taggedAt: number;
}

export interface HippocampusEntry {
  blockId: string;
  embedding: number[];
  entities: string[];
  topics: string[];
  temporalContext: string;
  indexedAt: number;
}

export interface CapacitorMount {
  id: string;
  path: string;
  projection: ProjectionType;
  blocks: Map<string, CodeBlock>;
  amygdala: Map<string, AmygdalaTag>;
  hippocampus: Map<string, HippocampusEntry>;
  mountedAt: number;
}

export interface CodeBlock {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  language: string;
  blockType: 'function' | 'class' | 'import' | 'comment' | 'other';
}

export type ProjectionType = 'text' | 'audio' | 'spatial' | 'reading';

export interface LayoutSolution {
  mountId: string;
  blocks: LayoutBlock[];
  totalValue: number;
  constraintsSatisfied: boolean;
}

export interface LayoutBlock {
  blockId: string;
  renderMode: 'full' | 'summary' | 'collapsed' | 'hidden';
  value: number;
  weight: number;
  position: number;
}

export interface PersonalizationContext {
  developerId: string;
  preferences: Record<string, unknown>;
  recentFiles: string[];
  focusArea?: string;
}

export interface SemanticCluster {
  id: string;
  topic: string;
  blockIds: string[];
  centroid: number[];
  coherence: number;
}

export interface ReadingMetrics {
  blockId: string;
  timeSpentMs: number;
  scrollPasses: number;
  lastViewed: number;
  engagement: number;
}

// ---------------------------------------------------------------------------
// CapacitorBridge
// ---------------------------------------------------------------------------

export class CapacitorBridge {
  private mounts = new Map<string, CapacitorMount>();
  private readingMetrics = new Map<string, ReadingMetrics>();
  private personalization: PersonalizationContext | null = null;

  /**
   * Mount a Capacitor over a file or directory.
   */
  mount(path: string, projection: ProjectionType = 'text'): CapacitorMount {
    const id = `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const mount: CapacitorMount = {
      id,
      path,
      projection,
      blocks: new Map(),
      amygdala: new Map(),
      hippocampus: new Map(),
      mountedAt: Date.now(),
    };
    this.mounts.set(id, mount);
    return mount;
  }

  /**
   * Unmount a Capacitor.
   */
  unmount(mountId: string): void {
    this.mounts.delete(mountId);
  }

  /**
   * Index a code block with the DualIndex.
   */
  indexBlock(mountId: string, block: CodeBlock): void {
    const mount = this.mounts.get(mountId);
    if (!mount) return;

    mount.blocks.set(block.id, block);

    // Amygdala: fast emotional tagging based on code patterns
    const emotion = this.tagEmotion(block);
    mount.amygdala.set(block.id, emotion);

    // Hippocampus: semantic context via simple heuristics
    const context = this.buildContext(block);
    mount.hippocampus.set(block.id, context);
  }

  /**
   * Get the current knapsack layout solution.
   */
  getLayout(mountId: string, maxBlocks = 50): LayoutSolution {
    const mount = this.mounts.get(mountId);
    if (!mount) {
      return {
        mountId,
        blocks: [],
        totalValue: 0,
        constraintsSatisfied: false,
      };
    }

    const layoutBlocks: LayoutBlock[] = [];
    let totalValue = 0;
    let position = 0;

    for (const [blockId, block] of mount.blocks) {
      const amygdala = mount.amygdala.get(blockId);
      const hippocampus = mount.hippocampus.get(blockId);
      const metrics = this.readingMetrics.get(blockId);

      // Calculate value: emotion intensity × relevance × freshness × engagement
      const emotionValue = amygdala ? amygdala.intensity : 0.5;
      const relevanceValue = hippocampus
        ? hippocampus.entities.length * 0.1 + 0.5
        : 0.5;
      const freshnessValue = Math.max(
        0.1,
        1 - (Date.now() - (hippocampus?.indexedAt ?? 0)) / 86_400_000
      );
      const engagementValue = metrics ? Math.min(1, metrics.engagement) : 0.3;

      const value =
        emotionValue * 0.3 +
        relevanceValue * 0.3 +
        freshnessValue * 0.2 +
        engagementValue * 0.2;
      const weight = block.endLine - block.startLine + 1;

      let renderMode: LayoutBlock['renderMode'] = 'full';
      if (value < 0.2) renderMode = 'hidden';
      else if (value < 0.4) renderMode = 'collapsed';
      else if (value < 0.6) renderMode = 'summary';

      layoutBlocks.push({ blockId, renderMode, value, weight, position });
      totalValue += value;
      position++;

      if (layoutBlocks.length >= maxBlocks) break;
    }

    // Sort by value descending
    layoutBlocks.sort((a, b) => b.value - a.value);

    return {
      mountId,
      blocks: layoutBlocks,
      totalValue,
      constraintsSatisfied: true,
    };
  }

  /**
   * Apply reader context for ESI personalization.
   */
  personalize(context: PersonalizationContext): void {
    this.personalization = context;
  }

  /**
   * Get semantic graph clusters for codebase navigation.
   */
  getClusters(mountId: string): SemanticCluster[] {
    const mount = this.mounts.get(mountId);
    if (!mount) return [];

    // Group blocks by file path as a simple clustering heuristic
    const fileGroups = new Map<string, string[]>();
    for (const [blockId, block] of mount.blocks) {
      const group = fileGroups.get(block.filePath) ?? [];
      group.push(blockId);
      fileGroups.set(block.filePath, group);
    }

    const clusters: SemanticCluster[] = [];
    let idx = 0;
    for (const [filePath, blockIds] of fileGroups) {
      const hippocampusEntries = blockIds
        .map((id) => mount.hippocampus.get(id))
        .filter((e): e is HippocampusEntry => !!e);

      const topics = new Set<string>();
      for (const entry of hippocampusEntries) {
        for (const topic of entry.topics) topics.add(topic);
      }

      clusters.push({
        id: `cluster-${idx++}`,
        topic: filePath.split('/').pop() ?? 'unknown',
        blockIds,
        centroid: [],
        coherence: blockIds.length > 1 ? 0.8 : 1.0,
      });
    }

    return clusters;
  }

  /**
   * Switch projection mode.
   */
  setProjection(mountId: string, projection: ProjectionType): void {
    const mount = this.mounts.get(mountId);
    if (mount) mount.projection = projection;
  }

  /**
   * Record reading analytics.
   */
  recordReading(blockId: string, timeSpentMs: number): void {
    const existing = this.readingMetrics.get(blockId);
    if (existing) {
      existing.timeSpentMs += timeSpentMs;
      existing.scrollPasses++;
      existing.lastViewed = Date.now();
      existing.engagement = Math.min(1, existing.timeSpentMs / 30_000);
    } else {
      this.readingMetrics.set(blockId, {
        blockId,
        timeSpentMs,
        scrollPasses: 1,
        lastViewed: Date.now(),
        engagement: Math.min(1, timeSpentMs / 30_000),
      });
    }
  }

  /**
   * Get all mounts.
   */
  getMounts(): CapacitorMount[] {
    return Array.from(this.mounts.values());
  }

  /**
   * Get reading metrics.
   */
  getReadingMetrics(): ReadingMetrics[] {
    return Array.from(this.readingMetrics.values());
  }

  private tagEmotion(block: CodeBlock): AmygdalaTag {
    const content = block.content.toLowerCase();

    // Simple emotion detection from code patterns
    let emotion = 'neutral';
    let valence = 0;
    let arousal = 0.3;
    let intensity = 0.5;

    if (/todo|fixme|hack|workaround|technical debt/.test(content)) {
      emotion = 'frustration';
      valence = -0.4;
      arousal = 0.6;
      intensity = 0.7;
    } else if (/bug|error|crash|fail|broken/.test(content)) {
      emotion = 'anxiety';
      valence = -0.6;
      arousal = 0.8;
      intensity = 0.8;
    } else if (/test|spec|assert|expect/.test(content)) {
      emotion = 'confidence';
      valence = 0.3;
      arousal = 0.4;
      intensity = 0.5;
    } else if (/feat|feature|new|implement/.test(content)) {
      emotion = 'excitement';
      valence = 0.6;
      arousal = 0.7;
      intensity = 0.7;
    } else if (/import|require|from/.test(content)) {
      emotion = 'neutral';
      valence = 0;
      arousal = 0.1;
      intensity = 0.2;
    }

    return {
      blockId: block.id,
      emotion,
      valence,
      arousal,
      dominance: 0.5,
      intensity,
      taggedAt: Date.now(),
    };
  }

  private buildContext(block: CodeBlock): HippocampusEntry {
    const content = block.content;

    // Extract entity-like identifiers
    const identifiers = content.match(/\b[A-Z][a-zA-Z0-9]+\b/g) ?? [];
    const entities = [...new Set(identifiers)].slice(0, 10);

    // Extract topic keywords
    const topics: string[] = [];
    if (block.blockType === 'function') topics.push('function');
    if (block.blockType === 'class') topics.push('class');
    if (/async|await|promise/i.test(content)) topics.push('async');
    if (/test|describe|it\(/i.test(content)) topics.push('testing');
    if (/fetch|http|api/i.test(content)) topics.push('networking');
    if (/sql|query|database/i.test(content)) topics.push('database');

    // Compute embedding asynchronously -- fire-and-forget to avoid blocking indexBlock()
    const entry: HippocampusEntry = {
      blockId: block.id,
      embedding: [],
      entities,
      topics,
      temporalContext: new Date().toISOString(),
      indexedAt: Date.now(),
    };

    // Background embedding computation via the local inference bridge
    this.computeBlockEmbedding(block.id, content.slice(0, 512), entry);

    return entry;
  }

  /**
   * Compute embedding for a code block in the background.
   * Updates the hippocampus entry in-place when the embedding is ready.
   */
  private computeBlockEmbedding(
    blockId: string,
    text: string,
    entry: HippocampusEntry
  ): void {
    import('./inference-bridge.ts')
      .then(({ embed }) =>
        embed(text, 'local').then(async (resp) => {
          const data = (await resp.json()) as {
            data?: Array<{ embedding?: number[] }>;
          };
          const vec = data?.data?.[0]?.embedding;
          if (vec && vec.length > 0) {
            entry.embedding = vec;
          }
        })
      )
      .catch(() => {
        // Embedding computation is best-effort -- index still works without it
      });
  }
}
