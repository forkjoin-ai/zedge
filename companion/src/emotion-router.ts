/**
 * Emotion Router -- Emotion-Driven Generation
 *
 * Routes inference tasks to different strategies based on the emotional
 * profile of the code being worked on. Closes the Capacitor feedback loop:
 *
 * - Anxious code (bugs, fragile logic) -> consensus strategy, 3+ models
 * - Frustrated code (TODOs, hacks) -> prioritize refactor in daydream
 * - Confident code (well-tested) -> fastest strategy, lower budget
 * - Neutral -> normal processing
 *
 * The void map (void-map-store.ts) records emotions alongside rejections,
 * enabling correlation analysis.
 */

import type { CollapseStrategy } from './superinference';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmotionalProfile {
  /** Dominant emotion across all blocks */
  dominantEmotion: string;
  /** Average valence (-1 to 1, negative = frustration) */
  avgValence: number;
  /** Average arousal (0 to 1, high = anxiety/excitement) */
  avgArousal: number;
  /** Emotion volatility (variance across blocks) */
  volatility: number;
  /** Number of blocks analyzed */
  blockCount: number;
  /** Per-emotion counts */
  emotionCounts: Record<string, number>;
}

export interface EmotionRouteDecision {
  /** Recommended collapse strategy */
  strategy: CollapseStrategy;
  /** Recommended number of models */
  modelCount: number;
  /** Confidence threshold adjustment */
  confidenceThreshold: number;
  /** Daydream priority multiplier (1.0 = normal) */
  daydreamPriority: number;
  /** Category emphasis for daydream */
  daydreamCategory?: string;
  /** Reasoning for the decision */
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Heuristic Emotion Detection (from code patterns)
// ---------------------------------------------------------------------------

const FRUSTRATION_MARKERS = [
  /\/\/\s*TODO/i,
  /\/\/\s*FIXME/i,
  /\/\/\s*HACK/i,
  /\/\/\s*XXX/i,
  /\/\/\s*TEMP/i,
  /\/\/\s*KLUDGE/i,
  /\/\*\s*TODO/i,
];

const ANXIETY_MARKERS = [
  /\/\/\s*BUG/i,
  /\/\/\s*WARN/i,
  /\/\/\s*DANGER/i,
  /\/\/\s*UNSAFE/i,
  /try\s*\{[\s\S]*?catch\s*\(/,
  /throw\s+new\s+Error/,
  /\.catch\s*\(/,
  /\/\/\s*FRAGILE/i,
];

const CONFIDENCE_MARKERS = [
  /describe\s*\(/,
  /test\s*\(/,
  /expect\s*\(/,
  /assert\s*[\.(]/,
  /it\s*\(/,
  /\/\/\s*TESTED/i,
  /\/\/\s*STABLE/i,
];

/**
 * Analyze code content and produce an emotional profile.
 * Uses heuristic pattern matching (no Capacitor dependency).
 */
export function analyzeCodeEmotion(content: string): EmotionalProfile {
  const lines = content.split('\n');
  let frustrationCount = 0;
  let anxietyCount = 0;
  let confidenceCount = 0;

  for (const line of lines) {
    for (const marker of FRUSTRATION_MARKERS) {
      if (marker.test(line)) {
        frustrationCount++;
        break;
      }
    }
    for (const marker of ANXIETY_MARKERS) {
      if (marker.test(line)) {
        anxietyCount++;
        break;
      }
    }
    for (const marker of CONFIDENCE_MARKERS) {
      if (marker.test(line)) {
        confidenceCount++;
        break;
      }
    }
  }

  const total = frustrationCount + anxietyCount + confidenceCount;
  if (total === 0) {
    return {
      dominantEmotion: 'neutral',
      avgValence: 0,
      avgArousal: 0,
      volatility: 0,
      blockCount: lines.length,
      emotionCounts: { neutral: lines.length },
    };
  }

  // Compute aggregate
  const emotionCounts: Record<string, number> = {};
  if (frustrationCount > 0) emotionCounts.frustration = frustrationCount;
  if (anxietyCount > 0) emotionCounts.anxiety = anxietyCount;
  if (confidenceCount > 0) emotionCounts.confidence = confidenceCount;

  const maxEmotion = Object.entries(emotionCounts).reduce(
    (max, [k, v]) => (v > max[1] ? [k, v] : max),
    ['neutral', 0]
  );

  // Valence: confidence pushes positive, frustration pushes negative
  const avgValence = (confidenceCount - frustrationCount) / total;
  // Arousal: anxiety and frustration increase arousal
  const avgArousal = (anxietyCount + frustrationCount * 0.5) / total;
  // Volatility: how mixed the emotions are
  const vals = [frustrationCount, anxietyCount, confidenceCount].filter(
    (v) => v > 0
  );
  const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
  const variance =
    vals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (vals.length || 1);
  const volatility = Math.sqrt(variance) / (total || 1);

  return {
    dominantEmotion: maxEmotion[0] as string,
    avgValence: Math.max(-1, Math.min(1, avgValence)),
    avgArousal: Math.max(0, Math.min(1, avgArousal)),
    volatility,
    blockCount: lines.length,
    emotionCounts,
  };
}

/**
 * Route a task based on the emotional profile of the target code.
 */
export function routeByEmotion(profile: EmotionalProfile): EmotionRouteDecision {
  const { dominantEmotion, avgValence, avgArousal } = profile;

  // High anxiety + high arousal -> consensus, careful
  if (dominantEmotion === 'anxiety' || (avgArousal > 0.6 && avgValence < -0.2)) {
    return {
      strategy: 'consensus',
      modelCount: 3,
      confidenceThreshold: 0.8,
      daydreamPriority: 1.5,
      daydreamCategory: 'bug-fix',
      reasoning: `Code shows signs of anxiety (arousal=${avgArousal.toFixed(2)}, valence=${avgValence.toFixed(2)}). Using consensus strategy with higher confidence threshold.`,
    };
  }

  // High frustration -> prioritize refactoring
  if (dominantEmotion === 'frustration' || avgValence < -0.3) {
    return {
      strategy: 'constructive',
      modelCount: 2,
      confidenceThreshold: 0.6,
      daydreamPriority: 2.0,
      daydreamCategory: 'refactor',
      reasoning: `Code shows signs of frustration (valence=${avgValence.toFixed(2)}). Prioritizing refactoring suggestions and using constructive strategy.`,
    };
  }

  // High confidence -> fast, trust the code
  if (dominantEmotion === 'confidence' || avgValence > 0.3) {
    return {
      strategy: 'fastest',
      modelCount: 1,
      confidenceThreshold: 0.5,
      daydreamPriority: 0.5,
      reasoning: `Code shows high confidence (valence=${avgValence.toFixed(2)}). Using fast strategy with lower daydream priority.`,
    };
  }

  // Neutral
  return {
    strategy: 'fastest',
    modelCount: 1,
    confidenceThreshold: 0.6,
    daydreamPriority: 1.0,
    reasoning: 'Neutral emotional profile. Using default strategy.',
  };
}
