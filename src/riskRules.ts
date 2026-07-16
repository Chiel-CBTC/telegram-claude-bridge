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
  // Piping a downloaded script straight into a shell interpreter — mirrors the
  // AI-classifier judgment call an interactive `claude` session would make, since
  // the bot has no equivalent classifier of its own.
  /\b(curl|wget)\b[\s\S]*?\|\s*(sudo\s+)?(sh|bash|zsh|dash)\b/i,
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

// Mirrors the `permissions.deny` list in the interactive CLI's own
// ~/.claude/settings.json (Read(~/.npmrc), Read(**/.env**), Read(**/*.pem)), plus
// SSH private key material — the bot has no such deny list of its own otherwise.
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..+)?$/i,
  /\.pem$/i,
  /(^|\/)\.ssh\//i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/i,
  /(^|\/)\.npmrc$/i,
];

function isSensitivePath(filePath: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
}

const WRITE_TOOL_NAMES = new Set(['Write', 'Edit', 'NotebookEdit']);
const FILE_PATH_TOOL_NAMES = new Set(['Read', ...WRITE_TOOL_NAMES]);

export function classifyToolUse(
  toolName: string,
  input: Record<string, unknown>,
  workingDir: string
): RiskDecision {
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    return classifyBashCommand(command);
  }

  if (FILE_PATH_TOOL_NAMES.has(toolName)) {
    const filePath = typeof input.file_path === 'string' ? input.file_path : '';
    if (filePath && isSensitivePath(filePath)) {
      return 'confirm';
    }
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
