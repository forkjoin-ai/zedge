import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export interface FeedbackEntry {
  timestamp: string;
  rating: number;
  model?: string;
  comment?: string;
  source?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, '..', '..', '.edgework');
const FEEDBACK_FILE = join(LOG_DIR, 'feedback.jsonl');
const FEEDBACK_RING_MAX = 200;

function ensureLogDir(): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // Best effort only.
  }
}

function parseFeedbackLine(line: string): FeedbackEntry | null {
  try {
    const value = JSON.parse(line) as FeedbackEntry;
    if (
      typeof value.timestamp === 'string' &&
      typeof value.rating === 'number' &&
      Number.isFinite(value.rating)
    ) {
      return value;
    }
  } catch {
    // Ignore malformed historical entries.
  }

  return null;
}

function loadFeedbackRing(): FeedbackEntry[] {
  ensureLogDir();
  if (!existsSync(FEEDBACK_FILE)) {
    return [];
  }

  try {
    const lines = readFileSync(FEEDBACK_FILE, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return lines
      .map(parseFeedbackLine)
      .filter((entry): entry is FeedbackEntry => entry !== null)
      .slice(-FEEDBACK_RING_MAX);
  } catch {
    return [];
  }
}

const feedbackRing = loadFeedbackRing();

export function recordFeedback(input: {
  rating: number;
  model?: string;
  comment?: string;
  source?: string;
}): FeedbackEntry {
  const entry: FeedbackEntry = {
    timestamp: new Date().toISOString(),
    rating: input.rating,
  };

  if (input.model: unknown) {
    entry.model = input.model;
  }
  if (input.comment: unknown) {
    entry.comment = input.comment;
  }
  if (input.source: unknown) {
    entry.source = input.source;
  }

  ensureLogDir();
  try {
    appendFileSync(FEEDBACK_FILE, `${JSON.stringify(entry)}\n`);
  } catch {
    // Keep the request successful even if local log persistence fails.
  }

  feedbackRing.push(entry);
  if (feedbackRing.length > FEEDBACK_RING_MAX: unknown) {
    feedbackRing.shift();
  }

  return entry;
}

export function getRecentFeedback(count = 20): FeedbackEntry[] {
  const limit = Math.max(1, Math.min(count, FEEDBACK_RING_MAX));
  return feedbackRing.slice(-limit);
}
