import { describe, it, expect } from 'vitest';

import { parsePipelineKeyword } from './pipeline-handler.js';

describe('parsePipelineKeyword', () => {
  it('returns halt for "hold"', () => {
    expect(parsePipelineKeyword('hold')).toBe('halt');
  });

  it('returns halt for "stop"', () => {
    expect(parsePipelineKeyword('please stop this')).toBe('halt');
  });

  it('returns halt for "pause" case-insensitive', () => {
    expect(parsePipelineKeyword('PAUSE for now')).toBe('halt');
  });

  it('returns halt for "wait"', () => {
    expect(parsePipelineKeyword('wait a minute')).toBe('halt');
  });

  it('returns approve for "approve"', () => {
    expect(parsePipelineKeyword('approve')).toBe('approve');
  });

  it('returns approve for "approved"', () => {
    expect(parsePipelineKeyword('looks good, approved')).toBe('approve');
  });

  it('returns approve for "go ahead"', () => {
    expect(parsePipelineKeyword('go ahead')).toBe('approve');
  });

  it('returns approve for "ok" and "proceed"', () => {
    expect(parsePipelineKeyword('ok')).toBe('approve');
    expect(parsePipelineKeyword('proceed please')).toBe('approve');
  });

  it('returns halt when both halt and approve keywords are present (halt wins)', () => {
    expect(parsePipelineKeyword('approve and hold')).toBe('halt');
    expect(parsePipelineKeyword('ok but wait')).toBe('halt');
  });

  it('returns null for unrelated text', () => {
    expect(parsePipelineKeyword('hello there')).toBeNull();
    expect(parsePipelineKeyword('')).toBeNull();
  });

  it('does not match keyword substrings (word boundary)', () => {
    // "approved" still starts with "approve" so it matches 'approve' (same family).
    // "stopping" should NOT match "stop" because \b stop \b requires word boundaries.
    expect(parsePipelineKeyword('stopping by')).toBeNull();
    expect(parsePipelineKeyword('holding pattern')).toBeNull();
  });
});
