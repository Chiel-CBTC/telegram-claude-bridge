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
  // the bot has no equivalent classifier of its own. Restricted to a single line
  // (like the git/rm patterns above) so an unrelated curl and an unrelated shell
  // pipe on separate lines of a multi-command script don't cross-match.
  /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|dash)\b/i,
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

// NotebookEdit uses `notebook_path` instead of `file_path`.
function getFilePath(toolName: string, input: Record<string, unknown>): string {
  const key = toolName === 'NotebookEdit' ? 'notebook_path' : 'file_path';
  return typeof input[key] === 'string' ? (input[key] as string) : '';
}

// MCP tool names are `mcp__<server>__<operation>`. There's no fixed catalog of
// operations across arbitrary MCP servers, so this fails closed: only operations
// that look read-only by name are auto-allowed, everything else — creates,
// updates, deletes, moves, and anything unrecognized — requires confirmation.
const READ_ONLY_MCP_TOKENS = new Set(['get', 'retrieve', 'list', 'query', 'search', 'read', 'fetch']);

function isReadOnlyMcpTool(toolName: string): boolean {
  const operation = toolName.slice(toolName.lastIndexOf('__') + 2);
  const tokens = operation.toLowerCase().split(/[-_]/);
  return tokens.some((token) => READ_ONLY_MCP_TOKENS.has(token));
}

export function classifyToolUse(
  toolName: string,
  input: Record<string, unknown>,
  workingDir: string
): RiskDecision {
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    return classifyBashCommand(command);
  }

  if (toolName.startsWith('mcp__')) {
    return isReadOnlyMcpTool(toolName) ? 'auto' : 'confirm';
  }

  if (FILE_PATH_TOOL_NAMES.has(toolName)) {
    const filePath = getFilePath(toolName, input);
    if (filePath && isSensitivePath(filePath)) {
      return 'confirm';
    }
  }

  if (WRITE_TOOL_NAMES.has(toolName)) {
    const filePath = getFilePath(toolName, input);
    if (filePath && isOutsideWorkingDir(filePath, workingDir)) {
      return 'confirm';
    }
    return 'auto';
  }

  return 'auto';
}
