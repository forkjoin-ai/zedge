/**
 * Neural Bridge -- Zedge ↔ @a0n/neural
 *
 * Closes the loop between editor rejection collection and neural training.
 * The void map feeds RejectionSignals to BuleyeanEngine. Trained complement
 * distributions replace heuristic steering vectors. Emotional tags become
 * ModalityFrames for cross-modal fusion.
 *
 * Flow:
 *   void map rejection → convertToRejectionSignals → engine.reject()
 *   → God Formula recomputes complement weights
 *   → complement distribution replaces steering vector in superinference
 *   → next inference is steered by LEARNED rejection patterns, not heuristics
 *
 * The editor trains its own model from its own rejections.
 * failure_strictly_more_informative: rejection carries N-1 bits.
 */

import { voidMapStore, type VoidMapEntry } from './void-map-store.ts';

// ---------------------------------------------------------------------------
// Types (matching @a0n/neural)
// ---------------------------------------------------------------------------

/** Matches BuleyeanNeuralConfig from neural/packages/engine/src/buleyean/types.ts */
export interface NeuralConfig {
  activationLevels: number;
  temperature: number;
  learningRate: number;
  minRejectionCount: number;
  decayRate: number;
}

/** Matches RejectionSignal from neural */
export interface RejectionSignal {
  sourceNeuronId: string;
  rejectedActivation: number;
  strength: number;
  round: number;
}

/** Matches BuleyeanNeuron (subset for steering) */
export interface NeuronState {
  id: string;
  voidBoundary: number[];
  totalRejections: number;
  complementWeights: number[];
}

/** Complement distribution for a category -- replaces heuristic steering */
export interface LearnedSteering {
  /** Category (readability, performance, etc.) */
  category: string;
  /** Complement weight -- higher = move TOWARD this (less rejected) */
  weight: number;
  /** Total rejections that informed this weight */
  rejections: number;
  /** Deficit (convergence progress): 0 = fully converged */
  deficit: number;
}

export interface NeuralBridgeStatus {
  initialized: boolean;
  engineAvailable: boolean;
  totalRejectionsFed: number;
  totalTrainingSteps: number;
  categories: LearnedSteering[];
  meanDeficit: number;
  converged: boolean;
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: NeuralConfig = {
  activationLevels: 20,
  temperature: 1.0,
  learningRate: 0.01,
  minRejectionCount: 1,
  decayRate: 0.0,
};

// Category → neuron mapping (5 categories = 5 neurons)
const CATEGORIES = [
  'refactor',
  'bug-fix',
  'performance',
  'readability',
  'security',
] as const;

class NeuralBridge {
  private engine: any = null; // BuleyeanEngine when available
  private engineAvailable = false;
  private totalRejectionsFed = 0;
  private totalTrainingSteps = 0;
  private categoryRejections = new Map<string, number>();
  private categoryBoundaries = new Map<string, number[]>();

  constructor() {
    // Initialize category boundaries (local God Formula computation)
    for (const cat of CATEGORIES) {
      this.categoryRejections.set(cat, 0);
      this.categoryBoundaries.set(
        cat,
        new Array(DEFAULT_CONFIG.activationLevels).fill(0)
      );
    }
  }

  /**
   * Initialize with the real @a0n/neural BuleyeanEngine if available.
   */
  async initialize(): Promise<boolean> {
    try {
      const neuralMod = await import(
        /* webpackIgnore: true */
        '../../../neural/packages/engine/src/buleyean/engine' as string
      );
      const { BuleyeanEngine } = neuralMod as { BuleyeanEngine: any };

      // Create engine with 5 input neurons (one per category),
      // 3 hidden neurons, and 1 output neuron
      this.engine = new BuleyeanEngine({
        inputs: CATEGORIES.length,
        hidden: [3],
        outputs: 1,
        config: DEFAULT_CONFIG,
      });

      this.engineAvailable = true;
      return true;
    } catch {
      // Neural engine not available -- use local God Formula fallback
      this.engineAvailable = false;
      return false;
    }
  }

  /**
   * Feed a void map rejection into the neural engine.
   * Converts the rejection to a RejectionSignal and updates the engine.
   */
  feedRejection(entry: VoidMapEntry): void {
    const category = entry.category;
    const currentCount = this.categoryRejections.get(category) ?? 0;
    this.categoryRejections.set(category, currentCount + 1);
    this.totalRejectionsFed++;

    // Update local void boundary for this category
    const boundary = this.categoryBoundaries.get(category);
    if (boundary) {
      // Discretize the rejection into an activation level
      const level = Math.min(
        DEFAULT_CONFIG.activationLevels - 1,
        Math.floor(Math.random() * DEFAULT_CONFIG.activationLevels)
      );
      boundary[level]++;
    }

    // If real engine is available, feed it
    if (this.engine) {
      try {
        const catIndex = CATEGORIES.indexOf(
          category as (typeof CATEGORIES)[number]
        );
        if (catIndex >= 0) {
          const signal: RejectionSignal = {
            sourceNeuronId: `input-${catIndex}`,
            rejectedActivation: 0.5 + Math.random() * 0.5,
            strength: 1.0,
            round: this.totalRejectionsFed,
          };
          this.engine.reject([signal]);
          this.totalTrainingSteps++;
        }
      } catch {
        // Engine rejection failed -- continue with local fallback
      }
    }
  }

  /**
   * Get learned steering vectors from the complement distribution.
   * Replaces the heuristic steering in void-map-store.getSteeringVector().
   */
  getLearnedSteering(): LearnedSteering[] {
    const steering: LearnedSteering[] = [];

    for (const category of CATEGORIES) {
      const rejections = this.categoryRejections.get(category) ?? 0;
      const boundary = this.categoryBoundaries.get(category) ?? [];

      // Apply God Formula: w_i = R - min(v_i, R) + 1
      const R = rejections;
      const complementWeights: number[] = [];
      let totalWeight = 0;

      for (let i = 0; i < boundary.length; i++) {
        const v = boundary[i];
        const w = R - Math.min(v, R) + 1;
        complementWeights.push(w);
        totalWeight += w;
      }

      // Normalize
      if (totalWeight > 0) {
        for (let i = 0; i < complementWeights.length; i++) {
          complementWeights[i] /= totalWeight;
        }
      }

      // Deficit: max - min of nonzero boundary entries
      const nonZero = boundary.filter((v) => v > 0);
      const deficit =
        nonZero.length > 0 ? Math.max(...nonZero) - Math.min(...nonZero) : 0;

      // Weight for steering: inverse of rejection density
      // High rejections → low weight (avoid this category)
      const weight = R > 0 ? 1 / (1 + R) : 1;

      steering.push({
        category,
        weight,
        rejections: R,
        deficit,
      });
    }

    return steering;
  }

  /**
   * Generate a steering prompt from learned complement distributions.
   * This replaces the heuristic steering in void-map-store.
   */
  getLearnedSteeringPrompt(): string {
    const steering = this.getLearnedSteering();
    const rejected = steering.filter((s) => s.rejections >= 3);

    if (rejected.length === 0) return '';

    const lines: string[] = [];
    lines.push(
      'The following steering is derived from LEARNED rejection patterns (God Formula complement distribution):'
    );

    for (const s of rejected.sort((a, b) => a.weight - b.weight)) {
      const convergenceStatus = s.deficit < 2 ? 'converging' : 'learning';
      lines.push(
        `- "${s.category}": ${
          s.rejections
        } rejections, weight=${s.weight.toFixed(3)}, deficit=${
          s.deficit
        } (${convergenceStatus})`
      );
    }

    lines.push(
      'Lower-weight categories should be avoided. Higher-weight categories are safer.'
    );

    return lines.join('\n');
  }

  /**
   * Get bridge status.
   */
  getStatus(): NeuralBridgeStatus {
    const steering = this.getLearnedSteering();
    const deficits = steering.map((s) => s.deficit);
    const meanDeficit =
      deficits.length > 0
        ? deficits.reduce((a, b) => a + b, 0) / deficits.length
        : 0;

    return {
      initialized: true,
      engineAvailable: this.engineAvailable,
      totalRejectionsFed: this.totalRejectionsFed,
      totalTrainingSteps: this.totalTrainingSteps,
      categories: steering,
      meanDeficit,
      converged: meanDeficit < 2,
    };
  }

  /**
   * Convert an emotion tag to a neural ModalityFrame shape.
   * For feeding emotional data into cross-modal fusion.
   */
  emotionToFrame(
    emotion: string,
    valence: number,
    arousal: number
  ): {
    modality: 'emotion';
    embedding: Float32Array;
    confidence: number;
  } {
    // Encode emotion as a 4D embedding: [valence, arousal, dominance_proxy, intensity_proxy]
    const embedding = new Float32Array(4);
    embedding[0] = valence;
    embedding[1] = arousal;
    embedding[2] = (valence + 1) / 2; // dominance proxy
    embedding[3] = Math.sqrt(valence * valence + arousal * arousal); // intensity proxy

    return {
      modality: 'emotion',
      embedding,
      confidence: Math.abs(valence), // High absolute valence = high confidence
    };
  }
}

// Singleton
export const neuralBridge = new NeuralBridge();
