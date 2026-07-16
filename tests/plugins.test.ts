import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPluginConfigs } from '../src/plugins';

let testFilePath: string;

beforeEach(() => {
  testFilePath = path.join(
    os.tmpdir(),
    `installed-plugins-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
});

afterEach(() => {
  if (fs.existsSync(testFilePath)) {
    fs.unlinkSync(testFilePath);
  }
});

function writeFixture(plugins: Record<string, Array<{ installPath: string }>>): void {
  fs.writeFileSync(testFilePath, JSON.stringify({ version: 2, plugins }), 'utf-8');
}

describe('loadPluginConfigs', () => {
  it('returns an empty array when the file does not exist', () => {
    expect(loadPluginConfigs(testFilePath, [])).toEqual([]);
  });

  it('returns an empty array when the file contains invalid JSON', () => {
    fs.writeFileSync(testFilePath, '{ not valid json', 'utf-8');
    expect(loadPluginConfigs(testFilePath, [])).toEqual([]);
  });

  it('returns a local plugin config for each installed plugin', () => {
    writeFixture({
      'chiel-skills@chiel-plugins': [
        { installPath: '/home/chiel/.claude/plugins/cache/chiel-plugins/chiel-skills/abc123' },
      ],
      'superpowers@claude-plugins-official': [
        { installPath: '/home/chiel/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1' },
      ],
    });

    const result = loadPluginConfigs(testFilePath, []);

    expect(result).toEqual([
      { type: 'local', path: '/home/chiel/.claude/plugins/cache/chiel-plugins/chiel-skills/abc123' },
      { type: 'local', path: '/home/chiel/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1' },
    ]);
  });

  it('excludes a plugin whose name (before the @) is in excludedNames', () => {
    writeFixture({
      'caveman@caveman': [
        { installPath: '/home/chiel/.claude/plugins/cache/caveman/caveman/0d95a81d35a9' },
      ],
      'superpowers@claude-plugins-official': [
        { installPath: '/home/chiel/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1' },
      ],
    });

    const result = loadPluginConfigs(testFilePath, ['caveman']);

    expect(result).toEqual([
      { type: 'local', path: '/home/chiel/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1' },
    ]);
  });

  it('includes every installPath when a plugin key has multiple entries', () => {
    writeFixture({
      'chiel-skills@chiel-plugins': [
        { installPath: '/home/chiel/.claude/plugins/cache/chiel-plugins/chiel-skills/abc123' },
        { installPath: '/home/chiel/.claude/plugins/cache/chiel-plugins/chiel-skills/def456' },
      ],
    });

    const result = loadPluginConfigs(testFilePath, []);

    expect(result).toEqual([
      { type: 'local', path: '/home/chiel/.claude/plugins/cache/chiel-plugins/chiel-skills/abc123' },
      { type: 'local', path: '/home/chiel/.claude/plugins/cache/chiel-plugins/chiel-skills/def456' },
    ]);
  });

  it('returns an empty array when a plugin entry list is not an array', () => {
    // Simulates a marketplace CLI version bump changing the shape of a
    // plugin's value from an array of entries to something else (here: an
    // object). Iterating a non-array with for-of throws a TypeError, which
    // must be caught rather than escaping loadPluginConfigs.
    fs.writeFileSync(
      testFilePath,
      JSON.stringify({ version: 2, plugins: { 'foo@bar': { installPath: '/wrong/shape' } } }),
      'utf-8'
    );

    expect(loadPluginConfigs(testFilePath, [])).toEqual([]);
  });

  it('returns an empty array when plugins itself is not an object', () => {
    fs.writeFileSync(testFilePath, JSON.stringify({ version: 2, plugins: 'not-an-object' }), 'utf-8');

    expect(loadPluginConfigs(testFilePath, [])).toEqual([]);
  });

  it('returns an empty array when the top-level parsed JSON is not an object', () => {
    // Valid JSON, but `null` at the top level means `parsed.plugins` throws
    // a TypeError ("Cannot read properties of null"). This exercises the
    // widened try/catch itself, not just the Array.isArray guard.
    fs.writeFileSync(testFilePath, 'null', 'utf-8');

    expect(loadPluginConfigs(testFilePath, [])).toEqual([]);
  });

  it('excludes nothing when excludedNames is empty or omitted', () => {
    writeFixture({
      'caveman@caveman': [
        { installPath: '/home/chiel/.claude/plugins/cache/caveman/caveman/0d95a81d35a9' },
      ],
    });

    expect(loadPluginConfigs(testFilePath)).toEqual([
      { type: 'local', path: '/home/chiel/.claude/plugins/cache/caveman/caveman/0d95a81d35a9' },
    ]);
  });
});
