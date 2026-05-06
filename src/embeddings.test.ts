import { afterEach, describe, expect, it, vi } from 'vitest';

describe('embeddings provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.LLAMACPP_EMBEDDING_URL;
    delete process.env.LLAMACPP_EMBEDDING_MODEL;
  });

  it('calls llama.cpp through the OpenAI-compatible embeddings endpoint', async () => {
    process.env.EMBEDDING_PROVIDER = 'llamacpp';
    process.env.LLAMACPP_EMBEDDING_URL = 'http://127.0.0.1:8081/v1/embeddings';
    process.env.LLAMACPP_EMBEDDING_MODEL = 'bge-m3';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ embedding: [0.1, '0.2', 0.3] }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { embedText, getEmbeddingModelName, getCompatibleEmbeddingModelNames } = await import('./embeddings.js');
    await expect(embedText('mission memory search')).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8081/v1/embeddings', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ model: 'bge-m3', input: 'mission memory search' }),
    }));
    expect(getEmbeddingModelName()).toBe('llamacpp:bge-m3');
    expect(getCompatibleEmbeddingModelNames()).toEqual(['llamacpp:bge-m3']);
  });

  it('fails closed when llama.cpp does not return a vector', async () => {
    process.env.EMBEDDING_PROVIDER = 'llamacpp';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{}] }), { status: 200 })));

    const { embedText } = await import('./embeddings.js');
    await expect(embedText('no vector')).rejects.toThrow('did not contain a vector');
  });

  it('keeps existing Gemini embedding model aliases compatible by default', async () => {
    process.env.EMBEDDING_PROVIDER = 'gemini';
    const { getCompatibleEmbeddingModelNames, getEmbeddingModelName } = await import('./embeddings.js');
    expect(getEmbeddingModelName()).toBe('gemini-embedding-001');
    expect(getCompatibleEmbeddingModelNames()).toEqual(expect.arrayContaining([
      'embedding-001',
      'gemini-embedding-001',
    ]));
  });
});
