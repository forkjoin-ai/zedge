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

import type { CollapseStrategy } from './superinference.ts';
import type { AmygdalaTag } from './capacitor-bridge.ts';
import { buleyeanWeight } from '@a0n/buleyean-kernel';

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
  /assert\s*[.(]/,
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
export function routeByEmotion(
  profile: EmotionalProfile
): EmotionRouteDecision {
  const { dominantEmotion, avgValence, avgArousal } = profile;

  // High anxiety + high arousal -> consensus, careful
  if (
    dominantEmotion === 'anxiety' ||
    (avgArousal > 0.6 && avgValence < -0.2)
  ) {
    return {
      strategy: 'consensus',
      modelCount: 3,
      confidenceThreshold: 0.8,
      daydreamPriority: 1.5,
      daydreamCategory: 'bug-fix',
      reasoning: `Code shows signs of anxiety (arousal=${avgArousal.toFixed(
        2
      )}, valence=${avgValence.toFixed(
        2
      )}). Using consensus strategy with higher confidence threshold.`,
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
      reasoning: `Code shows signs of frustration (valence=${avgValence.toFixed(
        2
      )}). Prioritizing refactoring suggestions and using constructive strategy.`,
    };
  }

  // High confidence -> fast, trust the code
  if (dominantEmotion === 'confidence' || avgValence > 0.3) {
    return {
      strategy: 'fastest',
      modelCount: 1,
      confidenceThreshold: 0.5,
      daydreamPriority: 0.5,
      reasoning: `Code shows high confidence (valence=${avgValence.toFixed(
        2
      )}). Using fast strategy with lower daydream priority.`,
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

// ---------------------------------------------------------------------------
// Capacitor-Aware Analysis
// ---------------------------------------------------------------------------

/**
 * Analyze emotional profile from Capacitor AmygdalaTag data.
 * Uses real sensor/tagging data instead of heuristic pattern matching.
 */
export function analyzeCodeEmotionFromCapacitor(
  tags: AmygdalaTag[]
): EmotionalProfile {
  if (tags.length === 0) {
    return {
      dominantEmotion: 'neutral',
      avgValence: 0,
      avgArousal: 0,
      volatility: 0,
      blockCount: 0,
      emotionCounts: { neutral: 1 },
    };
  }

  let totalValence = 0;
  let totalArousal = 0;
  const emotionCounts: Record<string, number> = {};

  for (const tag of tags) {
    totalValence += tag.valence;
    totalArousal += tag.arousal;
    emotionCounts[tag.emotion] = (emotionCounts[tag.emotion] ?? 0) + 1;
  }

  const avgValence = totalValence / tags.length;
  const avgArousal = totalArousal / tags.length;

  // Find dominant emotion
  const dominant = Object.entries(emotionCounts).reduce(
    (max, [k, v]) => (v > max[1] ? [k, v] : max),
    ['neutral', 0]
  );

  // Volatility: standard deviation of valence across tags
  const valenceVariance =
    tags.reduce((acc, t) => acc + (t.valence - avgValence) ** 2, 0) /
    tags.length;
  const volatility = Math.sqrt(valenceVariance);

  return {
    dominantEmotion: dominant[0] as string,
    avgValence: Math.max(-1, Math.min(1, avgValence)),
    avgArousal: Math.max(0, Math.min(1, avgArousal)),
    volatility,
    blockCount: tags.length,
    emotionCounts,
  };
}

/**
 * Analyze with Capacitor data when available, fallback to heuristics.
 */
export function analyzeCodeEmotionWithFallback(
  content: string,
  tags?: AmygdalaTag[]
): EmotionalProfile {
  if (tags && tags.length > 0) {
    return analyzeCodeEmotionFromCapacitor(tags);
  }
  return analyzeCodeEmotion(content);
}

// ---------------------------------------------------------------------------
// Void Boundary Model -- Buleyean complement routing
// ---------------------------------------------------------------------------

/**
 * Void boundary over code-emotion analyses.
 * `rounds` counts total analyses observed.
 * `entries` maps each emotion label to its rejection count.
 */
export interface CodeEmotionVoidBoundary {
  rounds: number;
  entries: Map<string, number>;
}

/**
 * Build a void boundary from a history of emotional profiles.
 *
 * For each profile the dominant emotion is selected; every other emotion
 * that appeared in that profile is recorded as a rejection. Emotions that
 * never appeared in a profile are not penalised -- the boundary only
 * tracks what was observed and not chosen.
 */
export function buildCodeVoidBoundary(
  analyses: EmotionalProfile[]
): CodeEmotionVoidBoundary {
  const entries = new Map<string, number>();
  let rounds = 0;

  for (const profile of analyses) {
    const emotions = Object.keys(profile.emotionCounts);
    if (emotions.length === 0) continue;
    rounds++;

    // Initialise any new emotions we haven't seen before
    for (const emotion of emotions) {
      if (!entries.has(emotion)) {
        entries.set(emotion, 0);
      }
    }

    // Everything that appeared but was NOT dominant is a rejection
    for (const emotion of emotions) {
      if (emotion !== profile.dominantEmotion) {
        entries.set(emotion, (entries.get(emotion) ?? 0) + 1);
      }
    }
  }

  return { rounds, entries };
}

/**
 * Route by complement distribution derived from the void boundary.
 *
 * - High dominant weight (novel / first encounter) -> `consensus`
 *   Unknown emotional territory -- proceed carefully with multi-model agreement.
 * - Low dominant weight (habituated / seen many times) -> `fastest`
 *   Routine emotional state -- speed is fine, we know this territory.
 * - Distributed weights (mixed emotional state) -> `constructive`
 *   No single emotion dominates the complement -- diverse perspectives help.
 */
export function routeByComplement(boundary: CodeEmotionVoidBoundary): {
  strategy: CollapseStrategy;
  reason: string;
} {
  const { rounds, entries } = boundary;

  if (rounds === 0 || entries.size === 0) {
    return {
      strategy: 'fastest',
      reason:
        'Empty void boundary -- no emotional history, defaulting to fastest.',
    };
  }

  // Compute Buleyean weights for every tracked emotion
  const weights = new Map<string, number>();
  let maxWeight = -Infinity;
  let totalWeight = 0;

  for (const [emotion, rejections] of entries) {
    const w = buleyeanWeight(rounds, rejections);
    weights.set(emotion, w);
    if (w > maxWeight) maxWeight = w;
    totalWeight += w;
  }

  // Normalised entropy of the weight distribution (0 = concentrated, 1 = uniform)
  const n = weights.size;
  let entropy = 0;
  if (n > 1 && totalWeight > 0) {
    for (const w of weights.values()) {
      const p = w / totalWeight;
      if (p > 0) entropy -= p * Math.log2(p);
    }
    entropy /= Math.log2(n); // normalise to [0, 1]
  }

  // Thresholds -- tuned by the ratio of max weight to the total
  const dominanceRatio = maxWeight / totalWeight;

  if (dominanceRatio > 0.6) {
    // One emotion has very high complement weight -- it was rarely rejected,
    // meaning it is novel or uncommon. Proceed with caution.
    return {
      strategy: 'consensus',
      reason: `Dominant complement weight ratio ${dominanceRatio.toFixed(
        2
      )} indicates novel emotional territory -- using consensus for safety.`,
    };
  }

  if (dominanceRatio < 0.35 || entropy > 0.85) {
    // Weights are spread across emotions -- mixed state needs diverse models.
    return {
      strategy: 'constructive',
      reason: `Distributed complement weights (entropy=${entropy.toFixed(
        2
      )}, dominance=${dominanceRatio.toFixed(
        2
      )}) -- using constructive for diverse perspectives.`,
    };
  }

  // Middle ground: habituated, known territory.
  return {
    strategy: 'fastest',
    reason: `Habituated emotional state (dominance=${dominanceRatio.toFixed(
      2
    )}, entropy=${entropy.toFixed(2)}) -- using fastest for routine work.`,
  };
}
