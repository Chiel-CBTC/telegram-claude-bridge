import { describe, it, expect, vi } from 'vitest';
import { decidePermission, describeToolUse } from '../src/permissionDecider';
import type { ApprovalBroker } from '../src/approvals';

const WORKING_DIR = '/home/chiel';

function fakeApprovalBroker(result: boolean): ApprovalBroker {
  return {
    request: vi.fn((_chatId: number, _description: string) => ({
      id: 'fake-id',
      promise: Promise.resolve(result),
    })),
    resolve: vi.fn(() => true),
  };
}

describe('describeToolUse', () => {
  it('describes a Bash tool call with its command', () => {
    expect(describeToolUse('Bash', { command: 'git push' })).toBe('Bash: git push');
  });

  it('describes a Write tool call with its file path', () => {
    expect(describeToolUse('Write', { file_path: '/etc/hosts' })).toBe('Write: /etc/hosts');
  });

  it('falls back to a JSON dump for unrecognized shapes', () => {
    expect(describeToolUse('Glob', { pattern: '**/*.ts' })).toBe('Glob: {"pattern":"**/*.ts"}');
  });
});

describe('decidePermission', () => {
  it('allows auto-classified tool calls without asking for approval', async () => {
    const approvalBroker = fakeApprovalBroker(true);
    const notifyApprovalNeeded = vi.fn();

    const result = await decidePermission(
      'Bash',
      { command: 'npm test' },
      { workingDir: WORKING_DIR, approvalBroker, chatId: 1, notifyApprovalNeeded }
    );

    expect(result).toEqual({ allow: true });
    expect(approvalBroker.request).not.toHaveBeenCalled();
    expect(notifyApprovalNeeded).not.toHaveBeenCalled();
  });

  it('requests approval for a risky Bash command and allows it when approved', async () => {
    const approvalBroker = fakeApprovalBroker(true);
    const notifyApprovalNeeded = vi.fn();

    const result = await decidePermission(
      'Bash',
      { command: 'git push origin main' },
      { workingDir: WORKING_DIR, approvalBroker, chatId: 1, notifyApprovalNeeded }
    );

    expect(result).toEqual({ allow: true });
    expect(approvalBroker.request).toHaveBeenCalledWith(1, 'Bash: git push origin main');
    expect(notifyApprovalNeeded).toHaveBeenCalledWith({ id: 'fake-id', description: 'Bash: git push origin main' });
  });

  it('denies a risky action when the approval is denied', async () => {
    const approvalBroker = fakeApprovalBroker(false);
    const notifyApprovalNeeded = vi.fn();

    const result = await decidePermission(
      'Bash',
      { command: 'sudo apt update' },
      { workingDir: WORKING_DIR, approvalBroker, chatId: 1, notifyApprovalNeeded }
    );

    expect(result).toEqual({ allow: false });
  });

  it('requests approval for a Write outside the working directory', async () => {
    const approvalBroker = fakeApprovalBroker(true);
    const notifyApprovalNeeded = vi.fn();

    await decidePermission(
      'Write',
      { file_path: '/etc/hosts' },
      { workingDir: WORKING_DIR, approvalBroker, chatId: 1, notifyApprovalNeeded }
    );

    expect(approvalBroker.request).toHaveBeenCalledWith(1, 'Write: /etc/hosts');
  });
});
