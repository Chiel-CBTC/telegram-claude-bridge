import { describe, it, expect } from 'vitest';
import { splitTelegramMessage } from '../src/telegramFormat';

describe('splitTelegramMessage', () => {
  it('returns an empty array for empty input', () => {
    expect(splitTelegramMessage('')).toEqual([]);
  });

  it('returns a single chunk for text under the limit', () => {
    const text = 'Hello, world!';
    expect(splitTelegramMessage(text)).toEqual([text]);
  });

  it('returns a single chunk for text exactly at the limit', () => {
    const text = 'a'.repeat(4096);
    const result = splitTelegramMessage(text);
    expect(result).toEqual([text]);
  });

  it('splits text over the limit into multiple chunks', () => {
    const text = 'a'.repeat(9000);
    const result = splitTelegramMessage(text);
    expect(result.length).toBeGreaterThan(1);
    expect(result.join('')).toBe(text);
  });

  it('never returns a chunk longer than maxLength', () => {
    const text = 'a'.repeat(9000);
    const result = splitTelegramMessage(text);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  it('prefers splitting on a newline boundary when one is available', () => {
    const line = 'x'.repeat(100);
    const text = Array(50).fill(line).join('\n');
    const result = splitTelegramMessage(text, 500);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(500);
    }
    for (const chunk of result.slice(0, -1)) {
      expect(chunk.endsWith(line)).toBe(true);
    }
  });

  it('respects a custom maxLength', () => {
    const text = 'a'.repeat(30);
    const result = splitTelegramMessage(text, 10);
    expect(result).toEqual(['aaaaaaaaaa', 'aaaaaaaaaa', 'aaaaaaaaaa']);
  });
});
