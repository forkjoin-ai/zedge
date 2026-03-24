import { describe, test, expect } from 'bun:test';
import {
  convertToDiagnostics,
  broadcastCandidates,
  broadcastCycleComplete,
  broadcastAccepted,
  broadcastRejected,
  getAnnotationClientCount,
  addAnnotationClient,
  removeAnnotationClient,
} from '../daydream-annotations';
import type { DaydreamCandidate, DaydreamCycle } from '../daydream';

const mockCandidate: DaydreamCandidate = {
  id: 'dream-test-1',
  filePath: '/test/file.ts',
  line: 42,
  suggestion: 'Extract this into a helper function',
  category: 'refactor',
  confidence: 0.7,
  createdAt: Date.now(),
};

describe('Daydream Annotations', () => {
  test('convertToDiagnostics produces hint-severity diagnostics', () => {
    const diagnostics = convertToDiagnostics([mockCandidate], 'file:///test/file.ts');

    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0].severity).toBe(4); // Hint
    expect(diagnostics[0].source).toBe('daydream');
    expect(diagnostics[0].message).toContain('refactor');
    expect(diagnostics[0].message).toContain('helper function');
    expect(diagnostics[0].range.start.line).toBe(41); // 0-indexed
    expect(diagnostics[0].data.candidateId).toBe('dream-test-1');
    expect(diagnostics[0].data.category).toBe('refactor');
    expect(diagnostics[0].data.confidence).toBe(0.7);
  });

  test('convertToDiagnostics handles multiple candidates', () => {
    const candidates: DaydreamCandidate[] = [
      mockCandidate,
      { ...mockCandidate, id: 'dream-test-2', line: 10, category: 'bug-fix', suggestion: 'Check for null' },
      { ...mockCandidate, id: 'dream-test-3', line: 55, category: 'security', suggestion: 'Sanitize input' },
    ];

    const diagnostics = convertToDiagnostics(candidates, 'file:///test/file.ts');
    expect(diagnostics.length).toBe(3);
    expect(diagnostics[0].code).toBe('dream-test-1');
    expect(diagnostics[1].code).toBe('dream-test-2');
    expect(diagnostics[2].code).toBe('dream-test-3');
  });

  test('convertToDiagnostics handles empty candidates', () => {
    const diagnostics = convertToDiagnostics([], 'file:///empty.ts');
    expect(diagnostics).toEqual([]);
  });

  test('broadcast functions do not throw without clients', () => {
    // No clients connected -- broadcasts should be no-ops
    expect(() => broadcastCandidates([mockCandidate])).not.toThrow();
    expect(() => broadcastCycleComplete({
      filePath: '/test/file.ts',
      candidates: [mockCandidate],
      durationMs: 100,
      model: 'test',
      timestamp: Date.now(),
    })).not.toThrow();
    expect(() => broadcastAccepted(mockCandidate)).not.toThrow();
    expect(() => broadcastRejected(mockCandidate)).not.toThrow();
  });

  test('getAnnotationClientCount starts at zero', () => {
    expect(getAnnotationClientCount()).toBe(0);
  });

  test('addAnnotationClient and removeAnnotationClient manage count', () => {
    const mockController = {} as ReadableStreamDefaultController;
    const before = getAnnotationClientCount();

    addAnnotationClient(mockController);
    expect(getAnnotationClientCount()).toBe(before + 1);

    removeAnnotationClient(mockController);
    expect(getAnnotationClientCount()).toBe(before);
  });
});
