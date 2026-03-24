/**
 * Cloud Run Coordinator URLs
 *
 * Single source of truth for all Cloud Run coordinator endpoints.
 * Used by inference-bridge.ts (for inference routing) and
 * latency-probe.ts (for health probing).
 */

export const CLOUD_RUN_COORDINATORS: Record<string, string> = {
  'tinyllama-1.1b':
    'https://inference-tinyllama-coordinator-6ptd7xm6fq-uc.a.run.app',
  'mistral-7b': 'https://inference-7b-coordinator-6ptd7xm6fq-uc.a.run.app',
  'qwen-2.5-coder-7b':
    'https://inference-qwen-coordinator-6ptd7xm6fq-uc.a.run.app',
  'gemma3-4b-it':
    'https://inference-gemma3-4b-it-coordinator-6ptd7xm6fq-uc.a.run.app',
  'gemma3-1b-it':
    'https://inference-gemma3-1b-it-coordinator-6ptd7xm6fq-uc.a.run.app',
  'glm-4-9b': 'https://inference-glm-4-9b-coordinator-6ptd7xm6fq-uc.a.run.app',
  'deepseek-r1':
    'https://inference-deepseek-r1-1-5b-coordinator-6ptd7xm6fq-uc.a.run.app',
  'personaplex-7b':
    'https://inference-personaplex-7b-coordinator-6ptd7xm6fq-uc.a.run.app',
  'lfm2.5-1.2b-glm-4.7-flash-thinking':
    'https://inference-lfm2-5-coordinator-6ptd7xm6fq-uc.a.run.app',
};
