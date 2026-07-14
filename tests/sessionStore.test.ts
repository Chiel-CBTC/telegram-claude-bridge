import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionStore } from '../src/sessionStore';

let testFilePath: string;

beforeEach(() => {
  testFilePath = path.join(
    os.tmpdir(),
    `session-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
});

afterEach(() => {
  if (fs.existsSync(testFilePath)) {
    fs.unlinkSync(testFilePath);
  }
});

describe('createSessionStore', () => {
  it('returns undefined for a chat with no stored session', () => {
    const store = createSessionStore(testFilePath);
    expect(store.get(123)).toBeUndefined();
  });

  it('returns the session id after set', () => {
    const store = createSessionStore(testFilePath);
    store.set(123, 'session-abc');
    expect(store.get(123)).toBe('session-abc');
  });

  it('persists to disk so a new store instance can read it back', () => {
    const store = createSessionStore(testFilePath);
    store.set(123, 'session-abc');

    const secondStore = createSessionStore(testFilePath);
    expect(secondStore.get(123)).toBe('session-abc');
  });

  it('creates the containing directory if it does not exist yet', () => {
    const nestedPath = path.join(os.tmpdir(), `session-store-nested-${Date.now()}`, 'sessions.json');
    const store = createSessionStore(nestedPath);
    store.set(1, 'abc');
    expect(fs.existsSync(nestedPath)).toBe(true);
    fs.rmSync(path.dirname(nestedPath), { recursive: true, force: true });
  });

  it('removes the mapping on reset', () => {
    const store = createSessionStore(testFilePath);
    store.set(123, 'session-abc');
    store.reset(123);
    expect(store.get(123)).toBeUndefined();
  });

  it('keeps separate mappings for different chat ids', () => {
    const store = createSessionStore(testFilePath);
    store.set(1, 'session-one');
    store.set(2, 'session-two');
    expect(store.get(1)).toBe('session-one');
    expect(store.get(2)).toBe('session-two');
  });
});
