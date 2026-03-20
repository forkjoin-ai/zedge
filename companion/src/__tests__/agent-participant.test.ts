import { describe, test, expect, beforeEach, mock } from 'bun:test';

// Mock DashRelay
mock.module('@dashrelay/client', () => ({
  DashRelay: class {
    config: Record<string, unknown>;
    constructor(c: Record<string, unknown>) {
      this.config = c;
    }
    async connect() {}
    disconnect() {}
    on() {}
    off() {}
  },
}));

// Mock yjs with UndoManager
mock.module('yjs', () => {
  class T {
    _content = '';
    _doc: unknown = null;
    get length() {
      return this._content.length;
    }
    insert(i: number, t: string) {
      this._content = this._content.slice(0, i) + t + this._content.slice(i);
    }
    delete(i: number, l: number) {
      this._content = this._content.slice(0, i) + this._content.slice(i + l);
    }
    toString() {
      return this._content;
    }
    observe() {}
    unobserve() {}
  }
  class M {
    _map = new Map();
    set(k: string, v: unknown) {
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
    forEach(fn: (value: unknown, key: string) => void) {
      this._map.forEach((v: unknown, k: string) => fn(v, k));
    }
    values() {
      return this._map.values();
    }
    keys() {
      return this._map.keys();
    }
    get size() {
      return this._map.size;
    }
    observe() {}
    unobserve() {}
  }
  class A {
    _arr: unknown[] = [];
    push(items: unknown[]) {
      this._arr.push(...items);
    }
    delete(i: number, l: number) {
      this._arr.splice(i, l);
    }
    toArray() {
      return [...this._arr];
    }
    get length() {
      return this._arr.length;
    }
    forEach(fn: (value: unknown, index: number, array: unknown[]) => void) {
      this._arr.forEach(fn);
    }
    observe() {}
    unobserve() {}
  }
  class D {
    clientID = Math.floor(Math.random() * 1e9);
    _texts = new Map();
    _maps = new Map();
    _arrays = new Map();
    _listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    getText(n: string) {
      if (!this._texts.has(n)) {
        const t = new T();
        (t as unknown as { _doc: unknown })._doc = this;
        this._texts.set(n, t);
      }
      return this._texts.get(n)!;
    }
    getMap(n: string) {
      if (!this._maps.has(n)) this._maps.set(n, new M());
      return this._maps.get(n)!;
    }
    getArray(n: string) {
      if (!this._arrays.has(n)) this._arrays.set(n, new A());
      return this._arrays.get(n)!;
    }
    getXmlFragment() {
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
      (this._listeners.get('update') || []).forEach((cb) =>
        cb(new Uint8Array(0), origin)
      );
    }
    on(e: string, fn: (...args: unknown[]) => void) {
      if (!this._listeners.has(e)) this._listeners.set(e, []);
      this._listeners.get(e)!.push(fn);
    }
    off() {}
    destroy() {
      this._listeners.clear();
    }
  }
  class U {
    _scope: unknown;
    constructor(s: unknown, _o?: unknown) {
      this._scope = s;
    }
    undo() {}
    redo() {}
    destroy() {}
  }
  return {
    Doc: D,
    Text: T,
    Map: M,
    Array: A,
    UndoManager: U,
    encodeStateAsUpdate: () => new Uint8Array(0),
    encodeStateVector: () => new Uint8Array(0),
    applyUpdate: () => {},
    transact: (
      d: { transact: (fn: () => void, o?: unknown) => void },
      fn: () => void,
      o?: unknown
    ) => d.transact(fn, o),
  };
});

const { CrdtBridge } = await import('../crdt-bridge');
const { AgentParticipant } = await import('../agent-participant');

describe('AgentParticipant', () => {
  test('openFile (joinFile) opens file and sets cursor', async () => {
    const crdt = new CrdtBridge({
      workspaceId: 'ws',
      peerId: 'p1',
      displayName: 'Alice',
    });
    await crdt.connect();

    const agent = new AgentParticipant(
      {
        agentId: 'agent-test',
        displayName: 'Test Agent',
        model: 'test-model',
        color: '#8b5cf6',
        mode: 'review',
      },
      crdt
    );
    await agent.join();

    const state = await agent.openFile('src/main.ts', 'const x = 1;');
    expect(state.path).toBe('src/main.ts');
    expect(state.content).toBe('const x = 1;');
    expect(state.cursorLine).toBe(0);
    expect(state.cursorCol).toBe(0);
  });

  test('insert inserts text at offset', async () => {
    const crdt = new CrdtBridge({
      workspaceId: 'ws',
      peerId: 'p1',
      displayName: 'Alice',
    });
    await crdt.connect();

    const agent = new AgentParticipant(
      {
        agentId: 'agent-test',
        displayName: 'Test Agent',
        model: 'test-model',
        color: '#8b5cf6',
        mode: 'pair',
      },
      crdt
    );
    await agent.join();
    await agent.openFile('src/main.ts', 'hello');

    const ok = agent.insert('src/main.ts', 5, ' world');
    expect(ok).toBe(true);

    const content = agent.readFile('src/main.ts');
    expect(content).toBe('hello world');
  });

  test('replace replaces text range', async () => {
    const crdt = new CrdtBridge({
      workspaceId: 'ws',
      peerId: 'p1',
      displayName: 'Alice',
    });
    await crdt.connect();

    const agent = new AgentParticipant(
      {
        agentId: 'agent-test',
        displayName: 'Test Agent',
        model: 'test-model',
        color: '#8b5cf6',
        mode: 'pair',
      },
      crdt
    );
    await agent.join();
    await agent.openFile('src/main.ts', 'hello world');

    const ok = agent.replace('src/main.ts', 6, 5, 'there');
    expect(ok).toBe(true);

    const content = agent.readFile('src/main.ts');
    expect(content).toBe('hello there');
  });

  test('undo calls undo on bridge', async () => {
    const crdt = new CrdtBridge({
      workspaceId: 'ws',
      peerId: 'p1',
      displayName: 'Alice',
    });
    await crdt.connect();

    const agent = new AgentParticipant(
      {
        agentId: 'agent-test',
        displayName: 'Test Agent',
        model: 'test-model',
        color: '#8b5cf6',
        mode: 'pair',
      },
      crdt
    );
    await agent.join();
    await agent.openFile('src/main.ts');

    // Should not throw
    agent.undo('src/main.ts');
  });

  test('getStatus returns correct values', async () => {
    const crdt = new CrdtBridge({
      workspaceId: 'ws',
      peerId: 'p1',
      displayName: 'Alice',
    });
    await crdt.connect();

    const agent = new AgentParticipant(
      {
        agentId: 'agent-qwen-7b',
        displayName: 'Qwen 7B',
        model: 'qwen-7b',
        color: '#8b5cf6',
        mode: 'review',
      },
      crdt
    );
    await agent.join();

    const status = agent.getStatus();
    expect(status.agentId).toBe('agent-qwen-7b');
    expect(status.displayName).toBe('Qwen 7B');
    expect(status.color).toBe('#8b5cf6');
    expect(status.mode).toBe('review');
  });

  test('setThinking updates activity', async () => {
    const crdt = new CrdtBridge({
      workspaceId: 'ws',
      peerId: 'p1',
      displayName: 'Alice',
    });
    await crdt.connect();

    const agent = new AgentParticipant(
      {
        agentId: 'agent-test',
        displayName: 'Test Agent',
        model: 'test-model',
        color: '#8b5cf6',
        mode: 'review',
      },
      crdt
    );
    await agent.join();

    agent.setThinking('analyzing code');
    const status = agent.getStatus();
    expect(status.activity).toEqual({
      type: 'thinking',
      context: 'analyzing code',
    });
  });
});
