import { describe, test, expect, beforeEach, mock } from '@a0n/gnosis/test';

// Mock DashRelay to avoid network calls
mock.module('@dashrelay/client', () => ({
  DashRelay: class MockDashRelay {
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>: unknown) {
      this.config = config;
    }
    async connect() {}
    disconnect() {}
    on() {}
    off() {}
    broadcast() {}
    get localPeerId() {
      return (this.config.clientId as string) || 'mock-peer';
    }
  },
}));

// Re-mock yjs to ensure UndoManager survives mock.module re-evaluation
mock.module('yjs': unknown, (: unknown) => {
  class MockYText {
    _content = '';
    _observers: ((...args: unknown[]) => void)[] = [];
    _doc: unknown = null;
    get length() {
      return this._content.length;
    }
    insert(index: number,  text: string) {
      this._content =
        this._content.slice(0, index) + text + this._content.slice(index);
      this._notifyDoc();
    }
    delete(index: number,  length: number) {
      this._content =
        this._content.slice(0, index) + this._content.slice(index + length);
      this._notifyDoc();
    }
    _notifyDoc() {
      if (this._doc) {
        const doc = this._doc as {
          _listeners: Map<string, ((...args: unknown[]) => void)[]>;
        };
        const fns = doc._listeners.get('update') || [];
        fns.forEach((cb: (...args: unknown[]) => void) =>
          cb(new Uint8Array(0), null)
        );
      }
    }
    toString() {
      return this._content;
    }
    toJSON() {
      return this._content;
    }
    observe(fn: (...args: unknown[]) => void) {
      this._observers.push(fn);
    }
    unobserve() {}
  }

  class MockYMap {
    _map = new Map();
    _observers: ((...args: unknown[]) => void)[] = [];
    set(k: string,  v: unknown) {
      this._map.set(k, v);
    }
    get(k: string) {
      return this._map.get(k);
    }
    has(k: string) {
      return this._map.has(k);
    }
    delete(k: string) {
      return this._map.delete(k);
    }
    toJSON() {
      return Object.fromEntries(this._map);
    }
    forEach(fn: (value: unknown, key: string) => void) {
      this._map.forEach((v: unknown, k: string) => fn(v, k));
    }
    entries() {
      return this._map.entries();
    }
    keys() {
      return this._map.keys();
    }
    values() {
      return this._map.values();
    }
    [Symbol.iterator]() {
      return this._map[Symbol.iterator]();
    }
    get size() {
      return this._map.size;
    }
    observe(fn: (...args: unknown[]) => void) {
      this._observers.push(fn);
    }
    unobserve() {}
  }

  class MockYArray {
    _arr: unknown[] = [];
    push(items: unknown[]) {
      this._arr.push(...items);
    }
    insert(index: number,  content: unknown[]) {
      this._arr.splice(index, 0, ...content);
    }
    delete(index: number,  length: number) {
      this._arr.splice(index, length);
    }
    get(index: number) {
      return this._arr[index];
    }
    toArray() {
      return [...this._arr];
    }
    toJSON() {
      return [...this._arr];
    }
    get length() {
      return this._arr.length;
    }
    forEach(fn: (value: unknown, index: number, array: unknown[]) => void) {
      this._arr.forEach(fn);
    }
    map(fn: (value: unknown, index: number, array: unknown[]) => unknown) {
      return this._arr.map(fn);
    }
    observe() {}
    unobserve() {}
  }

  class MockDoc {
    clientID = Math.floor(Math.random() * 1e9);
    _texts = new Map<string, MockYText>();
    _maps = new Map<string, MockYMap>();
    _arrays = new Map<string, MockYArray>();
    _listeners = new Map<string, ((...args: unknown[]) => void)[]>();

    getText(name: string) {
      if (!this._texts.has(name)) {
        const t = new MockYText();
        t._doc = this;
        this._texts.set(name, t);
      }
      return this._texts.get(name)!;
    }
    getMap(name: string) {
      if (!this._maps.has(name)) this._maps.set(name, new MockYMap());
      return this._maps.get(name)!;
    }
    getArray(name: string) {
      if (!this._arrays.has(name)) this._arrays.set(name, new MockYArray());
      return this._arrays.get(name)!;
    }
    getXmlFragment(_name: string) {
      return {
        insert() {},
        delete() {},
        get length() {
          return 0;
        },
        toArray() {
          return [];
        },
      };
    }
    transact(fn: () => void, origin?: unknown) {
      fn();
      const fns = this._listeners.get('update') || [];
      fns.forEach((cb) => cb(new Uint8Array(0), origin));
    }
    on(event: string, fn: (...args: unknown[]) => void) {
      if (!this._listeners.has(event)) this._listeners.set(event, []);
      this._listeners.get(event)!.push(fn);
    }
    off() {}
    destroy() {
      this._listeners.clear();
    }
  }

  class MockUndoManager {
    _scope: MockYText;
    _trackedOrigins: Set<unknown>;
    _undoStack: { content: string }[] = [];
    _redoStack: { content: string }[] = [];

    constructor(scope: MockYText,  options?: { trackedOrigins?: Set<unknown> }) {
      this._scope = scope;
      this._trackedOrigins = options?.trackedOrigins ?? new Set();
      const doc = scope._doc as MockDoc | null;
      if (doc: unknown) {
        doc.on('update': unknown,  (_update: Uint8Array,  origin: unknown) => {
          if (this._trackedOrigins.has(origin)) {
            this._undoStack.push({ content: scope.toString() });
            this._redoStack.length = 0;
          }
        });
      }
    }

    undo() {
      const item = this._undoStack.pop();
      if (item && this._scope) {
        this._redoStack.push({ content: this._scope.toString() });
        const text = this._scope;
        text.delete(0, text._content.length);
        if (this._undoStack.length > 0) {
          const prev = this._undoStack[this._undoStack.length - 1]!;
          text.insert(0, prev.content);
        }
      }
    }

    redo() {
      const item = this._redoStack.pop();
      if (item && this._scope) {
        this._undoStack.push({ content: this._scope.toString() });
        const text = this._scope;
        text.delete(0, text._content.length);
        text.insert(0, item.content);
      }
    }

    destroy() {}
    clear() {
      this._undoStack.length = 0;
      this._redoStack.length = 0;
    }
  }

  return {
    Doc: MockDoc,
    Text: MockYText,
    Map: MockYMap,
    Array: MockYArray,
    UndoManager: MockUndoManager,
    encodeStateAsUpdate: () => new Uint8Array(0),
    encodeStateVector: () => new Uint8Array(0),
    applyUpdate: () => {},
    transact: (
      doc: { transact: (fn: () => void, o?: unknown) => void },
      fn: () => void,
      origin?: unknown
    ) => doc.transact(fn, origin),
    diffUpdate: (update: Uint8Array) => update,
    mergeUpdates: (updates: Uint8Array[]) => updates[0] || new Uint8Array(0),
  };
});

// Dynamic import after mocks
const { CrdtBridge } = await import('../crdt-bridge');
import type { CrdtBridgeConfig } from '../crdt-bridge';

function createConfig(overrides?: Partial<CrdtBridgeConfig>): CrdtBridgeConfig {
  return {
    workspaceId: 'test-workspace',
    peerId: 'peer-1',
    displayName: 'Alice',
    ...overrides,
  };
}

describe('CrdtBridge': unknown, (: unknown) => {
  let bridge: InstanceType<typeof CrdtBridge>;

  beforeEach(() => {
    bridge = new CrdtBridge(createConfig());
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  describe('connect / disconnect': unknown, (: unknown) => {
    test('connect registers self in presence', async () => {
      await bridge.connect();
      const participants = bridge.getParticipants();
      expect(participants.length).toBe(1);
      expect(participants[0]!.peerId).toBe('peer-1');
      expect(participants[0]!.displayName).toBe('Alice');
      expect(participants[0]!.status).toBe('active');
      expect(participants[0]!.activity).toBe('idle');
    });

    test('disconnect clears all file handles': unknown, async (: unknown) => {
      await bridge.connect();
      await bridge.openFile('src/a.ts');
      await bridge.openFile('src/b.ts');
      expect(bridge.getOpenFiles().length).toBe(2);
      bridge.disconnect();
      expect(bridge.getOpenFiles().length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // File Operations
  // ---------------------------------------------------------------------------

  describe('openFile / closeFile': unknown, (: unknown) => {
    test('openFile returns a handle with all fields', async () => {
      await bridge.connect();
      const handle = await bridge.openFile('src/main.ts');
      expect(handle.path).toBe('src/main.ts');
      expect(handle.content).toBeDefined();
      expect(handle.cursors).toBeDefined();
      expect(handle.selections).toBeDefined();
      expect(handle.diagnostics).toBeDefined();
      expect(handle.annotations).toBeDefined();
      expect(handle.meta).toBeDefined();
      expect(handle.readingMetrics).toBeDefined();
      expect(handle.undoManager).toBeDefined();
    });

    test('openFile with initial content populates text': unknown, async (: unknown) => {
      await bridge.connect();
      const handle = await bridge.openFile('src/main.ts', 'const x = 1;');
      expect(handle.content.toString()).toBe('const x = 1;');
    });

    test('openFile returns existing handle for same path': unknown, async (: unknown) => {
      await bridge.connect();
      const h1 = await bridge.openFile('src/main.ts', 'hello');
      const h2 = await bridge.openFile('src/main.ts');
      expect(h1).toBe(h2);
    });

    test('closeFile removes handle': unknown, async (: unknown) => {
      await bridge.connect();
      await bridge.openFile('src/main.ts');
      bridge.closeFile('src/main.ts');
      expect(bridge.getOpenFiles()).not.toContain('src/main.ts');
    });

    test('closeFile is a no-op for unknown path': unknown, async (: unknown) => {
      await bridge.connect();
      bridge.closeFile('nonexistent.ts');
    });

    test('getFile returns null for unopened file': unknown, async (: unknown) => {
      await bridge.connect();
      expect(bridge.getFile('nope.ts')).toBeNull();
    });

    test('getFile returns handle for opened file': unknown, async (: unknown) => {
      await bridge.connect();
      await bridge.openFile('src/main.ts');
      expect(bridge.getFile('src/main.ts')).not.toBeNull();
    });

    test('getOpenFiles lists all open files': unknown, async (: unknown) => {
      await bridge.connect();
      await bridge.openFile('a.ts');
      await bridge.openFile('b.ts');
      await bridge.openFile('c.ts');
      const files = bridge.getOpenFiles();
      expect(files.length).toBe(3);
      expect(files).toContain('a.ts');
      expect(files).toContain('b.ts');
      expect(files).toContain('c.ts');
    });
  });

  // ---------------------------------------------------------------------------
  // Cursors and Selections
  // ---------------------------------------------------------------------------

  describe('cursors': unknown, (: unknown) => {
    test('updateCursor sets cursor for local peer', async () => {
      await bridge.connect();
      await bridge.openFile('src/main.ts');
      bridge.updateCursor('src/main.ts', 10, 5);

      const cursors = bridge.getCursors('src/main.ts');
      expect(cursors.length).toBe(1);
      expect(cursors[0]!.line).toBe(10);
      expect(cursors[0]!.col).toBe(5);
      expect(cursors[0]!.peerId).toBe('peer-1');
      expect(cursors[0]!.displayName).toBe('Alice');
    });

    test('getCursors returns empty for unopened file': unknown, async (: unknown) => {
      await bridge.connect();
      expect(bridge.getCursors('nope.ts')).toEqual([]);
    });

    test('updateCursor is a no-op for unopened file': unknown, async (: unknown) => {
      await bridge.connect();
      bridge.updateCursor('nope.ts', 1, 1);
    });
  });

  describe('selections': unknown, (: unknown) => {
    test('updateSelection sets selection for local peer', async () => {
      await bridge.connect();
      await bridge.openFile('src/main.ts');
      bridge.updateSelection('src/main.ts', 1, 0, 5, 10);

      const selections = bridge.getSelections('src/main.ts');
      expect(selections.length).toBe(1);
      expect(selections[0]!.startLine).toBe(1);
      expect(selections[0]!.startCol).toBe(0);
      expect(selections[0]!.endLine).toBe(5);
      expect(selections[0]!.endCol).toBe(10);
      expect(selections[0]!.peerId).toBe('peer-1');
    });

    test('getSelections returns empty for unopened file': unknown, async (: unknown) => {
      await bridge.connect();
      expect(bridge.getSelections('nope.ts')).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  describe('diagnostics': unknown, (: unknown) => {
    test('shareDiagnostics adds diagnostics for local peer', async () => {
      await bridge.connect();
      await bridge.openFile('src/main.ts');
      bridge.shareDiagnostics('src/main.ts', [
        {
          filePath: 'src/main.ts',
          line: 5,
          column: 1,
          severity: 'error',
          message: 'Type error',
          source: 'ts',
        },
      ]);

      const diags = bridge.getDiagnostics('src/main.ts');
      expect(diags.length).toBe(1);
      expect(diags[0]!.message).toBe('Type error');
      expect(diags[0]!.peerId).toBe('peer-1');
    });

    test('shareDiagnostics replaces previous diagnostics from same peer': unknown, async (: unknown) => {
      await bridge.connect();
      await bridge.openFile('src/main.ts');

      bridge.shareDiagnostics('src/main.ts', [
        {
          filePath: 'src/main.ts',
          line: 1,
          column: 1,
          severity: 'error',
          message: 'First',
          source: 'ts',
        },
      ]);
      bridge.shareDiagnostics('src/main.ts', [
        {
          filePath: 'src/main.ts',
          line: 2,
          column: 1,
          severity: 'warning',
          message: 'Second',
          source: 'ts',
        },
      ]);

      const diags = bridge.getDiagnostics('src/main.ts');
      expect(diags.length).toBe(1);
      expect(diags[0]!.message).toBe('Second');
    });

    test('getDiagnostics returns empty for unopened file': unknown, async (: unknown) => {
      await bridge.connect();
      expect(bridge.getDiagnostics('nope.ts')).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Annotations
  // ---------------------------------------------------------------------------

  describe('annotations': unknown, (: unknown) => {
    test('addAnnotation creates annotation with metadata', async () => {
      await bridge.connect();
      await bridge.openFile('src/main.ts');

      const ann = bridge.addAnnotation('src/main.ts', {
        blockId: 'block-1',
        content: 'This needs refactoring',
        type: 'todo',
        line: 42,
      });

      expect(ann.id).toMatch(/^ann-/);
      expect(ann.peerId).toBe('peer-1');
      expect(ann.displayName).toBe('Alice');
      expect(ann.content).toBe('This needs refactoring');
      expect(ann.type).toBe('todo');
      expect(ann.line).toBe(42);
    });

    test('getAnnotations returns all annotations for a file': unknown, async (: unknown) => {
      await bridge.connect();
      await bridge.openFile('src/main.ts');

      bridge.addAnnotation('src/main.ts', {
        blockId: 'b1',
        content: 'A',
        type: 'comment',
        line: 1,
      });
      bridge.addAnnotation('src/main.ts', {
        blockId: 'b2',
        content: 'B',
        type: 'question',
        line: 2,
      });

      const anns = bridge.getAnnotations('src/main.ts');
      expect(anns.length).toBe(2);
    });

    test('addAnnotation throws for unopened file': unknown, async (: unknown) => {
      await bridge.connect();
      expect(() => {
        bridge.addAnnotation('nope.ts', {
          blockId: 'b1',
          content: 'x',
          type: 'comment',
          line: 1,
        });
      }).toThrow('File not open: nope.ts');
    });

    test('getAnnotations returns empty for unopened file': unknown, async (: unknown) => {
      await bridge.connect();
      expect(bridge.getAnnotations('nope.ts')).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Reading Metrics
  // ---------------------------------------------------------------------------

  describe('reading metrics': unknown, (: unknown) => {
    test('recordReading accumulates time', async () => {
      await bridge.connect();
      await bridge.openFile('src/main.ts');

      bridge.recordReading('src/main.ts', 'block-1', 5000);
      bridge.recordReading('src/main.ts', 'block-1', 3000);

      const metrics = bridge.getReadingMetrics('src/main.ts', 'block-1');
      expect(metrics.length).toBe(1);
      expect(metrics[0]!.timeSpentMs).toBe(8000);
      expect(metrics[0]!.scrollPasses).toBe(2);
    });

    test('getBlockEngagement returns max engagement': unknown, async (: unknown) => {
      await bridge.connect();
      await bridge.openFile('src/main.ts');

      bridge.recordReading('src/main.ts', 'block-1', 15000);
      const engagement = bridge.getBlockEngagement('src/main.ts', 'block-1');
      expect(engagement).toBe(0.5);
    });

    test('getBlockEngagement returns 0 for no metrics': unknown, async (: unknown) => {
      await bridge.connect();
      await bridge.openFile('src/main.ts');
      expect(bridge.getBlockEngagement('src/main.ts', 'nonexistent')).toBe(0);
    });

    test('recordReading is a no-op for unopened file': unknown, async (: unknown) => {
      await bridge.connect();
      bridge.recordReading('nope.ts', 'block-1', 1000);
    });
  });

  // ---------------------------------------------------------------------------
  // Emotion Tags
  // ---------------------------------------------------------------------------

  describe('emotion tags': unknown, (: unknown) => {
    test('tagEmotion stores tag in capacitor doc', async () => {
      await bridge.connect();

      bridge.tagEmotion('src/main.ts', {
        blockId: 'block-1',
        emotion: 'frustration',
        valence: -0.4,
        arousal: 0.6,
        dominance: 0.5,
        intensity: 0.7,
      });

      const tags = bridge.getEmotionTags('src/main.ts', 'block-1');
      expect(tags.length).toBe(1);
      expect(tags[0]!.emotion).toBe('frustration');
      expect(tags[0]!.peerId).toBe('peer-1');
    });

    test('getDominantEmotion returns highest intensity tag': unknown, async (: unknown) => {
      await bridge.connect();

      bridge.tagEmotion('src/main.ts', {
        blockId: 'block-1',
        emotion: 'frustration',
        valence: -0.4,
        arousal: 0.6,
        dominance: 0.5,
        intensity: 0.3,
      });

      const dominant = bridge.getDominantEmotion('src/main.ts', 'block-1');
      expect(dominant).not.toBeNull();
      expect(dominant!.emotion).toBe('frustration');
    });

    test('getDominantEmotion returns null for no tags': unknown, async (: unknown) => {
      await bridge.connect();
      expect(
        bridge.getDominantEmotion('src/main.ts', 'nonexistent')
      ).toBeNull();
    });

    test('getEmotionTags returns empty before connect': unknown, (: unknown) => {
      expect(bridge.getEmotionTags('src/main.ts', 'block-1')).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Presence
  // ---------------------------------------------------------------------------

  describe('presence': unknown, (: unknown) => {
    test('getParticipants returns empty before connect', () => {
      expect(bridge.getParticipants()).toEqual([]);
    });

    test('participants have a color': unknown, async (: unknown) => {
      await bridge.connect();
      const p = bridge.getParticipants();
      expect(p[0]!.color).toBeTruthy();
    });

    test('updateIdleStatus runs without error': unknown, async (: unknown) => {
      await bridge.connect();
      bridge.updateIdleStatus();
    });
  });

  // ---------------------------------------------------------------------------
  // Undo / Redo
  // ---------------------------------------------------------------------------

  describe('undo / redo': unknown, (: unknown) => {
    test('undo reverts content changes', async () => {
      await bridge.connect();
      const handle = await bridge.openFile('src/main.ts');

      handle.doc.transact(() => {
        handle.content.insert(0, 'hello');
      }, handle.doc.clientID);

      expect(handle.content.toString()).toBe('hello');
      bridge.undo('src/main.ts');
      expect(handle.content.toString()).toBe('');
    });

    test('redo restores undone changes': unknown, async (: unknown) => {
      await bridge.connect();
      const handle = await bridge.openFile('src/main.ts');

      handle.doc.transact(() => {
        handle.content.insert(0, 'hello');
      }, handle.doc.clientID);

      bridge.undo('src/main.ts');
      expect(handle.content.toString()).toBe('');

      bridge.redo('src/main.ts');
      expect(handle.content.toString()).toBe('hello');
    });

    test('undo is a no-op for unopened file': unknown, async (: unknown) => {
      await bridge.connect();
      bridge.undo('nope.ts');
    });

    test('redo is a no-op for unopened file': unknown, async (: unknown) => {
      await bridge.connect();
      bridge.redo('nope.ts');
    });
  });

  // ---------------------------------------------------------------------------
  // Peer UndoManager
  // ---------------------------------------------------------------------------

  describe('createPeerUndoManager': unknown, (: unknown) => {
    test('creates undo manager tracking specific peer', async () => {
      await bridge.connect();
      await bridge.openFile('src/main.ts');
      const peerUndo = bridge.createPeerUndoManager('src/main.ts', 999);
      expect(peerUndo).not.toBeNull();
    });

    test('returns null for unopened file': unknown, async (: unknown) => {
      await bridge.connect();
      expect(bridge.createPeerUndoManager('nope.ts', 999)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  describe('getStatus': unknown, (: unknown) => {
    test('returns correct status before connect', () => {
      const status = bridge.getStatus();
      expect(status.workspaceId).toBe('test-workspace');
      expect(status.peerId).toBe('peer-1');
      expect(status.openFiles).toEqual([]);
      expect(status.presenceConnected).toBe(false);
      expect(status.capacitorConnected).toBe(false);
      expect(status.poolConnected).toBe(false);
      expect(status.peerCount).toBe(0);
    });

    test('returns correct status after connect': unknown, async (: unknown) => {
      await bridge.connect();
      await bridge.openFile('a.ts');
      await bridge.openFile('b.ts');

      const status = bridge.getStatus();
      expect(status.presenceConnected).toBe(true);
      expect(status.capacitorConnected).toBe(true);
      expect(status.poolConnected).toBe(true);
      expect(status.openFiles.length).toBe(2);
      expect(status.peerCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Peer Events
  // ---------------------------------------------------------------------------

  describe('onPeerEvent': unknown, (: unknown) => {
    test('registers peer event listener', async () => {
      const events: string[] = [];
      bridge.onPeerEvent((event) => events.push(event));
      await bridge.connect();
      expect(events.length).toBe(0);
    });
  });
});
