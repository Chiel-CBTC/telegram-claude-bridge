import type { ApprovalBroker } from './approvals.js';
import { classifyToolUse } from './riskRules.js';

export interface PermissionDecision {
  allow: boolean;
}

export interface DecidePermissionDeps {
  workingDir: string;
  approvalBroker: ApprovalBroker;
  chatId: number;
  notifyApprovalNeeded: (approval: { id: string; description: string }) => void;
}

export function describeToolUse(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof input.command === 'string') {
    return `Bash: ${input.command}`;
  }
  if (
    (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') &&
    typeof input.file_path === 'string'
  ) {
    return `${toolName}: ${input.file_path}`;
  }
  return `${toolName}: ${JSON.stringify(input)}`;
}

export async function decidePermission(
  toolName: string,
  input: Record<string, unknown>,
  deps: DecidePermissionDeps
): Promise<PermissionDecision> {
  const classification = classifyToolUse(toolName, input, deps.workingDir);

  if (classification === 'auto') {
    return { allow: true };
  }

  const description = describeToolUse(toolName, input);
  const { id, promise } = deps.approvalBroker.request(deps.chatId, description);
  deps.notifyApprovalNeeded({ id, description });

  const approved = await promise;
  return { allow: approved };
}
