import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConfig = vi.hoisted(() => ({ brain: 'sqlite' }));

vi.mock('./db.js', () => ({
  searchMemories: vi.fn(),
  getRecentHighImportanceMemories: vi.fn(),
  getOtherAgentActivity: vi.fn(() => []),
  getConsolidationsWithEmbeddings: vi.fn(() => []),
  touchMemory: vi.fn(),
  penalizeMemory: vi.fn(),
  batchUpdateMemoryRelevance: vi.fn(),
  decayMemories: vi.fn(),
  logConversationTurn: vi.fn(),
  pruneConversationLog: vi.fn(),
  pruneWaMessages: vi.fn(() => ({ messages: 0, outbox: 0, map: 0 })),
  pruneSlackMessages: vi.fn(() => 0),
  searchConsolidations: vi.fn(),
  getRecentConsolidations: vi.fn(),
}));

vi.mock('./memory-ingest.js', () => ({
  ingestConversationTurn: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('./embeddings.js', () => ({
  embedText: vi.fn(() => Promise.resolve([])),
  cosineSimilarity: vi.fn(() => 0),
}));

vi.mock('./gemini.js', () => ({
  generateContent: vi.fn(() => Promise.resolve('[]')),
  parseJsonResponse: vi.fn(() => []),
}));

vi.mock('./config.js', () => ({
  agentObsidianConfig: undefined,
  get BRAIN() { return mockConfig.brain; },
  GOOGLE_API_KEY: '',
  MEMORY_NUDGE_INTERVAL_TURNS: 10,
  MEMORY_NUDGE_INTERVAL_HOURS: 2,
}));

vi.mock('./brain/adapter.js', () => ({
  ob1Available: vi.fn(() => false),
  buildMemoryContextOb1: vi.fn(() => Promise.resolve('[OB1 memory]')),
}));

import {
  buildMemoryContext,
  saveConversationTurn,
  runDecaySweep,
} from './memory.js';

import {
  searchMemories,
  getRecentHighImportanceMemories,
  touchMemory,
  decayMemories,
  logConversationTurn,
  searchConsolidations,
  getRecentConsolidations,
} from './db.js';

import { ingestConversationTurn } from './memory-ingest.js';
import { buildMemoryContextOb1, ob1Available } from './brain/adapter.js';

const mockSearchMemories = vi.mocked(searchMemories);
const mockGetRecentHighImportance = vi.mocked(getRecentHighImportanceMemories);
const mockTouchMemory = vi.mocked(touchMemory);
const mockDecayMemories = vi.mocked(decayMemories);
const mockLogConversationTurn = vi.mocked(logConversationTurn);
const mockSearchConsolidations = vi.mocked(searchConsolidations);
const mockGetRecentConsolidations = vi.mocked(getRecentConsolidations);
const mockIngest = vi.mocked(ingestConversationTurn);
const mockOb1Available = vi.mocked(ob1Available);
const mockBuildMemoryContextOb1 = vi.mocked(buildMemoryContextOb1);

beforeEach(() => {
  mockConfig.brain = 'sqlite';
  mockOb1Available.mockReturnValue(false);
  mockBuildMemoryContextOb1.mockResolvedValue('[OB1 memory]');
});

function makeMemory(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    chat_id: 'chat1',
    source: 'conversation',
    agent_id: 'main',
    raw_text: 'raw text',
    summary: 'A test memory',
    entities: '[]',
    topics: '[]',
    connections: '[]',
    importance: 0.7,
    salience: 1.0,
    consolidated: 0,
    pinned: 0,
    embedding: null,
    created_at: 100,
    accessed_at: 100,
    ...overrides,
  };
}

describe('buildMemoryContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.brain = 'sqlite';
    mockOb1Available.mockReturnValue(false);
    mockBuildMemoryContextOb1.mockResolvedValue('[OB1 memory]');
    mockSearchConsolidations.mockReturnValue([]);
    mockGetRecentConsolidations.mockReturnValue([]);
  });

  it('returns empty string when no memories found', async () => {
    mockSearchMemories.mockReturnValue([]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'hello');
    expect(contextText).toBe('');
  });

  it('returns formatted string when FTS results exist', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ summary: 'User enjoys pizza', topics: '["food"]', importance: 0.8 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'pizza');
    expect(contextText).toContain('[Memory context]');
    expect(contextText).toContain('User enjoys pizza');
    expect(contextText).toContain('food');
    expect(contextText).toContain('[0.8]');
    expect(contextText).toContain('[End memory context]');
  });

  it('deduplicates between FTS and recent results', async () => {
    const mem = makeMemory({ summary: 'shared memory' });
    mockSearchMemories.mockReturnValue([mem]);
    mockGetRecentHighImportance.mockReturnValue([mem]);

    const { contextText } = await buildMemoryContext('chat1', 'shared');
    const occurrences = contextText.split('shared memory').length - 1;
    expect(occurrences).toBe(1);
  });

  it('does NOT touch memories at retrieval (feedback loop handles this)', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ id: 10 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([
      makeMemory({ id: 20 }),
    ]);

    const { surfacedMemoryIds, surfacedMemorySummaries } = await buildMemoryContext('chat1', 'test');
    expect(mockTouchMemory).not.toHaveBeenCalled();
    expect(surfacedMemoryIds).toContain(10);
    expect(surfacedMemoryIds).toContain(20);
    expect(surfacedMemorySummaries.get(10)).toBe('A test memory');
  });

  it('passes strict agent isolation through memory retrieval and skips consolidation blocks when requested', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ id: 30, summary: 'Mason-only context', agent_id: 'mason' }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'frontend', 'mason', {
      strictAgentId: 'mason',
      includeConsolidations: false,
      includeTeamActivity: false,
    });

    expect(contextText).toContain('Mason-only context');
    expect(mockSearchMemories).toHaveBeenCalledWith('chat1', 'frontend', 5, undefined, 'mason');
    expect(mockGetRecentHighImportance).toHaveBeenCalledWith('chat1', 5, 'mason');
    expect(mockSearchConsolidations).not.toHaveBeenCalled();
    expect(mockGetRecentConsolidations).not.toHaveBeenCalled();
  });

  it('bypasses OB1 when strict agent isolation is requested', async () => {
    mockConfig.brain = 'ob1';
    mockOb1Available.mockReturnValue(true);
    mockSearchMemories.mockReturnValue([
      makeMemory({ id: 31, summary: 'Warden-only context', agent_id: 'warden' }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'health', 'warden', {
      strictAgentId: 'warden',
      includeConsolidations: false,
      includeTeamActivity: false,
    });

    expect(contextText).toContain('Warden-only context');
    expect(mockBuildMemoryContextOb1).not.toHaveBeenCalled();
    expect(mockSearchMemories).toHaveBeenCalledWith('chat1', 'health', 5, undefined, 'warden');
  });
});

describe('saveConversationTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs both user and assistant messages to conversation log', () => {
    saveConversationTurn('chat1', 'hello world from the user!!!', 'Noted.');
    expect(mockLogConversationTurn).toHaveBeenCalledWith('chat1', 'user', 'hello world from the user!!!', undefined, 'main');
    expect(mockLogConversationTurn).toHaveBeenCalledWith('chat1', 'assistant', 'Noted.', undefined, 'main');
  });

  it('fires async ingestion', () => {
    saveConversationTurn('chat1', 'I prefer TypeScript over JavaScript always and forever', 'Noted.');
    expect(mockIngest).toHaveBeenCalledWith('chat1', 'I prefer TypeScript over JavaScript always and forever', 'Noted.', 'main');
  });
});

describe('buildMemoryContext with consolidations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchMemories.mockReturnValue([]);
    mockGetRecentHighImportance.mockReturnValue([]);
  });

  it('includes consolidation insights when searchConsolidations returns results', async () => {
    mockSearchConsolidations.mockReturnValue([
      { id: 1, chat_id: 'chat1', source_ids: '[1,2]', summary: 'Morning routine synthesis', insight: 'User has structured morning workflow', created_at: 100 },
    ]);

    const { contextText } = await buildMemoryContext('chat1', 'morning routine');
    expect(contextText).toContain('Insights:');
    expect(contextText).toContain('User has structured morning workflow');
  });

  it('falls back to recent consolidations when search returns empty', async () => {
    mockSearchConsolidations.mockReturnValue([]);
    mockGetRecentConsolidations.mockReturnValue([
      { id: 1, chat_id: 'chat1', source_ids: '[1]', summary: 'General insight', insight: 'User values productivity', created_at: 100 },
    ]);

    const { contextText } = await buildMemoryContext('chat1', 'unrelated query');
    expect(contextText).toContain('User values productivity');
  });

  it('returns empty when no memories and no insights exist', async () => {
    mockSearchConsolidations.mockReturnValue([]);
    mockGetRecentConsolidations.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'anything');
    expect(contextText).toBe('');
  });

  it('includes both memories and insights when both exist', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ summary: 'Prefers dark mode', importance: 0.8, topics: '["UI"]' }),
    ]);
    mockSearchConsolidations.mockReturnValue([
      { id: 1, chat_id: 'chat1', source_ids: '[1]', summary: 'UI summary', insight: 'User cares deeply about UI aesthetics', created_at: 100 },
    ]);

    const { contextText } = await buildMemoryContext('chat1', 'UI preferences');
    expect(contextText).toContain('Prefers dark mode');
    expect(contextText).toContain('User cares deeply about UI aesthetics');
    expect(contextText).toContain('Relevant memories:');
    expect(contextText).toContain('Insights:');
  });
});

describe('buildMemoryContext topic formatting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchConsolidations.mockReturnValue([]);
    mockGetRecentConsolidations.mockReturnValue([]);
  });

  it('includes parsed topics in the formatted output', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ summary: 'Likes hiking', topics: '["outdoor", "fitness"]', importance: 0.7 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'hiking');
    expect(contextText).toContain('outdoor');
    expect(contextText).toContain('fitness');
  });

  it('handles empty topics gracefully', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ summary: 'No topics memory', topics: '[]', importance: 0.6 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'query');
    expect(contextText).toContain('No topics memory');
    // Should not have trailing topic parentheses
    expect(contextText).not.toContain('()');
  });

  it('handles malformed topics JSON gracefully', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ summary: 'Bad topics', topics: 'not-json', importance: 0.6 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'query');
    expect(contextText).toContain('Bad topics');
    // Should not crash
  });
});

describe('runDecaySweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls decayMemories once', () => {
    runDecaySweep();
    expect(mockDecayMemories).toHaveBeenCalledOnce();
  });
});
