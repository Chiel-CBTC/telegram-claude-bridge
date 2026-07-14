import path from 'node:path';

export type RiskDecision = 'auto' | 'confirm';

const CONFIRM_BASH_PATTERNS: RegExp[] = [
  /\bgit\s+push\b/i,
  /\bgit\s+reset\b[^\n]*--hard\b/i,
  /\bgit\s+clean\b[^\n]*-[a-z]*f/i,
  /\bgit\s+checkout\s+--\s/i,
  /\brm\s+[^\n]*-[a-z]*r[a-z]*f\b/i,
  /\brm\s+[^\n]*-[a-z]*f[a-z]*r\b/i,
  /\bsudo\b/i,
];

function classifyBashCommand(command: string): RiskDecision {
  return CONFIRM_BASH_PATTERNS.some((pattern) => pattern.test(command)) ? 'confirm' : 'auto';
}

function isOutsideWorkingDir(filePath: string, workingDir: string): boolean {
  const resolvedPath = path.resolve(filePath);
  const resolvedWorkingDir = path.resolve(workingDir);
  const relative = path.relative(resolvedWorkingDir, resolvedPath);
  return relative.startsWith('..') || path.isAbsolute(relative);
}

const WRITE_TOOL_NAMES = new Set(['Write', 'Edit', 'NotebookEdit']);

export function classifyToolUse(
  toolName: string,
  input: Record<string, unknown>,
  workingDir: string
): RiskDecision {
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    return classifyBashCommand(command);
  }

  if (WRITE_TOOL_NAMES.has(toolName)) {
    const filePath = typeof input.file_path === 'string' ? input.file_path : '';
    if (filePath && isOutsideWorkingDir(filePath, workingDir)) {
      return 'confirm';
    }
    return 'auto';
  }

  return 'auto';
}
