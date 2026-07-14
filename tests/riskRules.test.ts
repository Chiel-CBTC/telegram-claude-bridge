import { describe, it, expect } from 'vitest';
import { classifyToolUse } from '../src/riskRules';

const WORKING_DIR = '/home/chiel';

describe('classifyToolUse — Bash commands', () => {
  const cases: Array<[string, 'auto' | 'confirm']> = [
    ['git push origin main', 'confirm'],
    ['git push', 'confirm'],
    ['git reset --hard HEAD~1', 'confirm'],
    ['git clean -fd', 'confirm'],
    ['git checkout -- src/index.ts', 'confirm'],
    ['rm -rf /tmp/build', 'confirm'],
    ['rm -fr node_modules', 'confirm'],
    ['sudo apt update', 'confirm'],
    ['ls -la', 'auto'],
    ['npm test', 'auto'],
    ['git status', 'auto'],
    ['git commit -m "fix"', 'auto'],
    ['rm build.log', 'auto'],
  ];

  for (const [command, expected] of cases) {
    it(`classifies "${command}" as ${expected}`, () => {
      const result = classifyToolUse('Bash', { command }, WORKING_DIR);
      expect(result).toBe(expected);
    });
  }
});

describe('classifyToolUse — file writes', () => {
  it('allows writing inside the working directory', () => {
    const result = classifyToolUse('Write', { file_path: '/home/chiel/git/foo/bar.ts' }, WORKING_DIR);
    expect(result).toBe('auto');
  });

  it('requires confirmation for writes outside the working directory', () => {
    const result = classifyToolUse('Write', { file_path: '/etc/passwd' }, WORKING_DIR);
    expect(result).toBe('confirm');
  });

  it('requires confirmation for path-traversal writes that escape the working directory', () => {
    const result = classifyToolUse(
      'Write',
      { file_path: '/home/chiel/../root/.ssh/authorized_keys' },
      WORKING_DIR
    );
    expect(result).toBe('confirm');
  });

  it('does not false-positive on a sibling directory sharing a prefix', () => {
    const result = classifyToolUse('Write', { file_path: '/home/chiel2/evil.ts' }, WORKING_DIR);
    expect(result).toBe('confirm');
  });

  it('applies the same rule to Edit', () => {
    const result = classifyToolUse('Edit', { file_path: '/etc/hosts' }, WORKING_DIR);
    expect(result).toBe('confirm');
  });
});

describe('classifyToolUse — other tools', () => {
  it('allows Read regardless of path (not covered by the write rule)', () => {
    const result = classifyToolUse('Read', { file_path: '/etc/hosts' }, WORKING_DIR);
    expect(result).toBe('auto');
  });

  it('allows tools with no special classification by default', () => {
    const result = classifyToolUse('Glob', { pattern: '**/*.ts' }, WORKING_DIR);
    expect(result).toBe('auto');
  });
});
