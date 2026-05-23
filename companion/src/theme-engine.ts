/**
 * Zedge Theme Engine -- Emotion-Aware Dynamic Theming
 *
 * Reads the Capacitor emotional profile for the active file and computes
 * subtle mood shifts to the base AeonOS palette. The editor's visual
 * identity reflects the emotional state of your code.
 *
 * - High confidence -> warmer accent (blue shifts toward teal)
 * - High anxiety -> cooler, calmer palette (deeper blue)
 * - High frustration -> slightly muted, focused
 * - Neutral -> base AeonOS palette
 *
 * Shifts are subtle (5-10% hue/saturation) -- enough to notice
 * subconsciously, not enough to distract.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  analyzeCodeEmotion,
  routeByEmotion,
  type EmotionalProfile,
  type EmotionRouteDecision,
} from './emotion-router.ts';

// ---------------------------------------------------------------------------
// Base AeonOS Palette (from shared-ui/src/styles/tokens/aeon.css)
// ---------------------------------------------------------------------------

export interface ThemePalette {
  /** Base palette name */
  name: string;
  /** Mood shift applied */
  mood: string;
  /** Background colors */
  bg: {
    root: string;
    surface: string;
    elevated: string;
    hover: string;
  };
  /** Accent colors (shifted by mood) */
  accent: {
    primary: string;
    hover: string;
    muted: string;
    text: string;
  };
  /** Gnosis keyword colors */
  gnosis: {
    fork: string;
    race: string;
    fold: string;
    vent: string;
  };
  /** Emotional profile that produced this palette */
  emotionalProfile?: EmotionalProfile;
  /** Routing decision */
  routeDecision?: EmotionRouteDecision;
}

const BASE_PALETTE: ThemePalette = {
  name: 'Zedge Dark',
  mood: 'neutral',
  bg: {
    root: '#09090b',
    surface: '#0c0c0f',
    elevated: '#111114',
    hover: '#18181b',
  },
  accent: {
    primary: '#3b82f6', // Signal Blue
    hover: '#60a5fa',
    muted: 'rgba(59, 130, 246, 0.15)',
    text: '#93c5fd',
  },
  gnosis: {
    fork: '#10b981', // emerald
    race: '#f59e0b', // amber
    fold: '#06b6d4', // cyan
    vent: '#ef4444', // red
  },
};

// ---------------------------------------------------------------------------
// Color manipulation helpers
// ---------------------------------------------------------------------------

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) return [0, 0, l];

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;

  return [h * 360, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));

  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  if (s === 0) {
    const v = Math.round(l * 255);
    return `#${v.toString(16).padStart(2, '0')}${v
      .toString(16)
      .padStart(2, '0')}${v.toString(16).padStart(2, '0')}`;
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = Math.round(hue2rgb(p, q, h / 360 + 1 / 3) * 255);
  const g = Math.round(hue2rgb(p, q, h / 360) * 255);
  const b = Math.round(hue2rgb(p, q, h / 360 - 1 / 3) * 255);

  return `#${r.toString(16).padStart(2, '0')}${g
    .toString(16)
    .padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function shiftHue(hex: string, deltaH: number, deltaS = 0, deltaL = 0): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h + deltaH, s + deltaS, l + deltaL);
}

// ---------------------------------------------------------------------------
// Mood Shift
// ---------------------------------------------------------------------------

function applyMoodShift(profile: EmotionalProfile): ThemePalette {
  const route = routeByEmotion(profile);
  const palette = JSON.parse(JSON.stringify(BASE_PALETTE)) as ThemePalette;
  palette.emotionalProfile = profile;
  palette.routeDecision = route;

  const { dominantEmotion, avgValence, avgArousal } = profile;

  if (dominantEmotion === 'confidence' || avgValence > 0.3) {
    // Warmer -- shift blue toward teal (reduce hue by 15-20 degrees)
    palette.mood = 'confident';
    palette.accent.primary = shiftHue(BASE_PALETTE.accent.primary, -15, 0.05);
    palette.accent.hover = shiftHue(BASE_PALETTE.accent.hover, -15, 0.05);
    palette.accent.text = shiftHue(BASE_PALETTE.accent.text, -15, 0.05);
  } else if (
    dominantEmotion === 'anxiety' ||
    (avgArousal > 0.6 && avgValence < -0.2)
  ) {
    // Cooler, calmer -- deeper blue (increase hue slightly, reduce saturation)
    palette.mood = 'anxious';
    palette.accent.primary = shiftHue(
      BASE_PALETTE.accent.primary,
      10,
      -0.1,
      -0.03
    );
    palette.accent.hover = shiftHue(BASE_PALETTE.accent.hover, 10, -0.1, -0.03);
    palette.accent.text = shiftHue(BASE_PALETTE.accent.text, 10, -0.1);
  } else if (dominantEmotion === 'frustration' || avgValence < -0.3) {
    // Slightly muted -- reduce saturation, warmer undertone
    palette.mood = 'frustrated';
    palette.accent.primary = shiftHue(BASE_PALETTE.accent.primary, -5, -0.08);
    palette.accent.hover = shiftHue(BASE_PALETTE.accent.hover, -5, -0.08);
    palette.accent.text = shiftHue(BASE_PALETTE.accent.text, -5, -0.05);
  } else {
    palette.mood = 'neutral';
  }

  return palette;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the current theme palette, optionally adjusted for a file's emotional profile.
 */
export function getThemePalette(filePath?: string): ThemePalette {
  if (!filePath) return { ...BASE_PALETTE };

  try {
    const fullPath = resolve(process.env.AEON_ROOT || process.cwd(), filePath);
    if (!existsSync(fullPath)) return { ...BASE_PALETTE };

    const content = readFileSync(fullPath, 'utf-8');
    const profile = analyzeCodeEmotion(content);
    return applyMoodShift(profile);
  } catch {
    return { ...BASE_PALETTE };
  }
}

/**
 * Get the base (unshifted) palette.
 */
export function getBasePalette(): ThemePalette {
  return { ...BASE_PALETTE };
}
