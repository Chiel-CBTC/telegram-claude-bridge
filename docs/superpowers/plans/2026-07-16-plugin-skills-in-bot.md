# Plugins/skills beschikbaar maken in de Telegram-bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De Telegram-bot laadt dezelfde Claude Code-plugins/skills als een interactieve terminal-sessie, gelezen live uit de door de plugin-marketplace beheerde `~/.claude/plugins/installed_plugins.json`, zodat marketplace-updates zonder rebuild doorwerken.

**Architecture:** Nieuwe pure-logic module `src/plugins.ts` leest `installed_plugins.json` en zet elke niet-uitgesloten plugin om naar een lokaal SDK-plugin-config-object. `src/config.ts` krijgt een nieuw `excludedPlugins`-veld (default `['caveman']`, overrideable via `EXCLUDED_PLUGINS`). `src/claudeSession.ts` roept `loadPluginConfigs` bij elk bericht opnieuw aan en geeft het resultaat mee aan `query()` als `plugins`-optie, los van `settingSources: []`.

**Tech Stack:** TypeScript (Node.js, ESM/NodeNext), `@anthropic-ai/claude-agent-sdk`, vitest.

## Global Constraints

- `settingSources: []` in `src/claudeSession.ts` blijft ongewijzigd — de `canUseTool`-gate blijft de enige autoriteit over tool-uitvoering; de `plugins`-optie is hier los van.
- De pluginlijst wordt **bij elk Telegram-bericht opnieuw ingelezen** vanaf disk (geen caching bij opstarten of tussen berichten).
- Default `excludedPlugins` is `['caveman']` wanneer `EXCLUDED_PLUGINS` niet gezet is; een expliciet lege `EXCLUDED_PLUGINS=` geeft `[]` (niets uitgesloten).
- Relatieve imports binnen `src/` gebruiken een expliciete `.js`-extensie (NodeNext module resolution), bv. `from './plugins.js'`. Imports in `tests/` gebruiken geen extensie, conform bestaande bestanden.
- Bestandslezingen volgen het bestaande patroon uit `src/sessionStore.ts`: `fs.existsSync` vóór `fs.readFileSync`, geen try/catch voor "bestaat niet" — alleen voor JSON-parse-fouten.
- README- en `.env.example`-toelichtingen in het Nederlands, consistent met de rest van het project. Code, identifiers en commit-messages in het Engels.

---

### Task 1: `loadPluginConfigs` in `src/plugins.ts`

**Files:**
- Create: `src/plugins.ts`
- Test: `tests/plugins.test.ts`

**Interfaces:**
- Produces: `loadPluginConfigs(installedPluginsPath: string, excludedNames?: readonly string[]): SdkPluginConfig[]`, waarbij `SdkPluginConfig` het type `{ type: 'local'; path: string }` is, geïmporteerd uit `@anthropic-ai/claude-agent-sdk`.

- [ ] **Step 1: Write the failing tests**

Maak `tests/plugins.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/plugins.test.ts`
Expected: FAIL — `Cannot find module '../src/plugins'` (or similar resolution error), since `src/plugins.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

Maak `src/plugins.ts`:

```ts
import fs from 'node:fs';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';

interface InstalledPluginEntry {
  installPath?: string;
}

interface InstalledPluginsFile {
  plugins?: Record<string, InstalledPluginEntry[]>;
}

// installed_plugins.json is owned by the plugin marketplace CLI; reading it
// fresh (no caching) lets `/plugin update`/`/plugin install` run in a
// terminal take effect in the bot without a rebuild.
export function loadPluginConfigs(
  installedPluginsPath: string,
  excludedNames: readonly string[] = []
): SdkPluginConfig[] {
  if (!fs.existsSync(installedPluginsPath)) {
    return [];
  }

  const raw = fs.readFileSync(installedPluginsPath, 'utf-8');
  let parsed: InstalledPluginsFile;
  try {
    parsed = JSON.parse(raw) as InstalledPluginsFile;
  } catch {
    console.warn(`plugins: kon ${installedPluginsPath} niet parsen, laad geen plugins`);
    return [];
  }

  const excluded = new Set(excludedNames);
  const paths = new Set<string>();

  for (const [key, entries] of Object.entries(parsed.plugins ?? {})) {
    const pluginName = key.split('@')[0];
    if (excluded.has(pluginName)) {
      continue;
    }
    for (const entry of entries) {
      if (entry.installPath) {
        paths.add(entry.installPath);
      }
    }
  }

  return [...paths].map((path) => ({ type: 'local' as const, path }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/plugins.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/plugins.ts tests/plugins.test.ts
git commit -m "feat: read installed plugin configs from installed_plugins.json"
```

---

### Task 2: `excludedPlugins` in `src/config.ts`

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `Config.excludedPlugins: string[]` (nieuw veld op de bestaande `Config`-interface).

- [ ] **Step 1: Write the failing tests**

Voeg toe aan `tests/config.test.ts`, binnen de bestaande `describe('loadConfig', ...)`-blok, na de laatste bestaande `it(...)`:

```ts
  it('defaults excludedPlugins to ["caveman"] when EXCLUDED_PLUGINS is not set', () => {
    const config = loadConfig(validEnv);
    expect(config.excludedPlugins).toEqual(['caveman']);
  });

  it('parses a comma-separated EXCLUDED_PLUGINS, trimming whitespace', () => {
    const env = { ...validEnv, EXCLUDED_PLUGINS: 'caveman, impeccable ,skill-creator' };
    const config = loadConfig(env);
    expect(config.excludedPlugins).toEqual(['caveman', 'impeccable', 'skill-creator']);
  });

  it('returns an empty array when EXCLUDED_PLUGINS is explicitly set to an empty string', () => {
    const env = { ...validEnv, EXCLUDED_PLUGINS: '' };
    const config = loadConfig(env);
    expect(config.excludedPlugins).toEqual([]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/config.test.ts`
Expected: FAIL — `config.excludedPlugins` is `undefined`, `toEqual(['caveman'])` etc. fail.

- [ ] **Step 3: Write the implementation**

In `src/config.ts`, voeg het veld toe aan de interface:

```ts
export interface Config {
  telegramBotToken: string;
  allowedTelegramUserId: number;
  anthropicApiKey: string;
  workingDir: string;
  claudeModel: string;
  approvalTimeoutMs: number;
  sessionStorePath: string;
  notionToken?: string;
  excludedPlugins: string[];
}
```

Voeg een helper toe vóór `loadConfig` en gebruik hem in de return:

```ts
const DEFAULT_EXCLUDED_PLUGINS = ['caveman'];

function parseExcludedPlugins(raw: string | undefined): string[] {
  if (raw === undefined) {
    return DEFAULT_EXCLUDED_PLUGINS;
  }
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // ... bestaande body ongewijzigd tot aan de return ...
  return {
    telegramBotToken,
    allowedTelegramUserId,
    anthropicApiKey,
    workingDir: env.WORKING_DIR?.trim() || '/home/chiel',
    claudeModel: env.CLAUDE_MODEL?.trim() || 'claude-sonnet-5',
    approvalTimeoutMs: env.APPROVAL_TIMEOUT_MS ? Number(env.APPROVAL_TIMEOUT_MS) : 15 * 60 * 1000,
    sessionStorePath: env.SESSION_STORE_PATH?.trim() || './data/sessions.json',
    notionToken: env.NOTION_TOKEN?.trim() || undefined,
    excludedPlugins: parseExcludedPlugins(env.EXCLUDED_PLUGINS),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/config.test.ts`
Expected: PASS (alle tests, inclusief de 3 nieuwe)

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add excludedPlugins config field (EXCLUDED_PLUGINS)"
```

---

### Task 3: Plugins wiren in `src/claudeSession.ts` en `src/index.ts`

**Files:**
- Modify: `src/claudeSession.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `loadPluginConfigs(installedPluginsPath: string, excludedNames?: readonly string[]): SdkPluginConfig[]` (Task 1, `src/plugins.ts`); `Config.excludedPlugins: string[]` (Task 2, `src/config.ts`).
- Produces: `CreateClaudeSessionRunnerDeps.excludedPlugins?: string[]`; de `query()`-call in `sendMessageNow` geeft `plugins` mee wanneer er niet-uitgesloten plugins geïnstalleerd zijn.

- [ ] **Step 1: Voeg imports en het nieuwe deps-veld toe in `src/claudeSession.ts`**

Bovenaan het bestand, na de bestaande imports:

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';
import os from 'node:os';
import path from 'node:path';
import type { SessionStore } from './sessionStore.js';
import type { ApprovalBroker } from './approvals.js';
import { decidePermission } from './permissionDecider.js';
import { createPerKeySerializer } from './perKeySerializer.js';
import { loadPluginConfigs } from './plugins.js';
```

In `CreateClaudeSessionRunnerDeps`, na `notionToken?: string;`:

```ts
  // Plugin names (matched against the part before '@' in
  // installed_plugins.json) to exclude from the bot session. Loaded via
  // loadConfig()'s excludedPlugins; defaults to ['caveman'] there.
  excludedPlugins?: string[];
```

- [ ] **Step 2: Bereken het plugin-pad eenmalig en lees de lijst per bericht**

In `createClaudeSessionRunner`, direct na `const mcpServers = buildMcpServers(deps);`:

```ts
  const excludedPlugins = deps.excludedPlugins ?? [];
  // installed_plugins.json is owned by the plugin marketplace CLI (the same
  // one used interactively in a terminal on this host); reading it fresh on
  // every message means updates there take effect without a bot rebuild.
  const installedPluginsPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
```

In `sendMessageNow`, direct vóór `const stream = query({`:

```ts
    const plugins = loadPluginConfigs(installedPluginsPath, excludedPlugins);
```

En in de `options`-object van de `query()`-call, naast de bestaande `...(mcpServers ? { mcpServers } : {})`-regel:

```ts
        ...(mcpServers ? { mcpServers } : {}),
        ...(plugins.length > 0 ? { plugins } : {}),
```

- [ ] **Step 3: Geef `excludedPlugins` mee vanuit `src/index.ts`**

In de `createClaudeSessionRunner({...})`-call, na `notionToken: config.notionToken,`:

```ts
  notionToken: config.notionToken,
  excludedPlugins: config.excludedPlugins,
});
```

- [ ] **Step 4: Typecheck en volledige testsuite draaien**

Run: `npm run build`
Expected: geen TypeScript-fouten.

Run: `npm test`
Expected: alle tests slagen (inclusief de nieuwe uit Task 1 en 2; `claudeSession.ts` zelf heeft geen unit tests, consistent met de bestaande situatie — het bestand roept de echte SDK aan).

- [ ] **Step 5: Commit**

```bash
git add src/claudeSession.ts src/index.ts
git commit -m "feat: load local plugin configs into the Claude session"
```

---

### Task 4: Documentatie — README en `.env.example`

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: Nieuwe README-sectie**

Voeg toe aan `README.md`, na de sectie "## Notion access (optional)" en vóór "## Logs":

```markdown
## Skills/plugins in de bot

De bot laadt automatisch dezelfde Claude Code-skills/plugins die je hier in de terminal via
de plugin marketplace hebt geïnstalleerd (`~/.claude/plugins/installed_plugins.json`) — geen
aparte installatie of sync nodig. Voeg je een plugin toe of update je er een via
`/plugin install`/`/plugin update` in de terminal, dan pikt de bot dat bij het eerstvolgende
bericht automatisch op, zonder herbouwen.

Standaard uitgesloten: `caveman`. Die plugin activeert namelijk standaard caveman-spreekstijl
bij sessiestart en deelt zijn modus-vlag (`~/.claude/.caveman-active`) met je terminal-sessies
op deze machine — meenemen in de bot zou dus ook je terminal-caveman-modus kunnen beïnvloeden
en andersom.

Pas de uitsluitlijst aan via `EXCLUDED_PLUGINS` in `.env` (komma-gescheiden pluginnamen, het
deel vóór de `@` in `installed_plugins.json`), bijvoorbeeld:

```
EXCLUDED_PLUGINS=caveman,impeccable
```

Zet hem expliciet op leeg (`EXCLUDED_PLUGINS=`) om ook `caveman` mee te nemen. Na een wijziging
in `.env`: `docker compose up -d --build`.
```

- [ ] **Step 2: Nieuwe `.env.example`-regel**

Voeg toe aan `.env.example`, na de `NOTION_TOKEN`-toelichting en vóór het blok met `WORKING_DIR`/`CLAUDE_MODEL`/etc.:

```
# Optioneel — komma-gescheiden lijst van plugin-namen die de bot NIET moet laden
# (het deel vóór de '@' in ~/.claude/plugins/installed_plugins.json). Standaard
# (var niet gezet): caveman uitgesloten (deelt spreekstijl/modus-state met je
# terminal-sessies). Zet op EXCLUDED_PLUGINS= (leeg) om niets uit te sluiten.
# EXCLUDED_PLUGINS=caveman
```

- [ ] **Step 3: Commit**

```bash
git add README.md .env.example
git commit -m "docs: document plugin/skill loading and EXCLUDED_PLUGINS"
```

---

### Task 5: Eindverificatie

**Files:** geen wijzigingen — alleen commando's draaien.

- [ ] **Step 1: Volledige testsuite en build**

Run: `npm test`
Expected: alle tests slagen.

Run: `npm run build`
Expected: geen TypeScript-fouten.

- [ ] **Step 2: Handmatige verificatie op de server (door Chiel, niet geautomatiseerd)**

Deze stap draai je zelf, niet de implementerende agent, omdat hij een echte deploy en een
Telegram-bericht vereist:

1. `docker compose up -d --build`
2. Stuur de bot een bericht dat een skill triggert die je normaal alleen in de terminal
   gebruikt (bv. één die `chiel-skills` of `superpowers` aanroept) en controleer dat het
   verwachte skill-gedrag optreedt.
3. Stuur een bericht en controleer dat de bot **niet** in caveman-spreekstijl antwoordt
   (bevestigt dat de default-exclude werkt).
4. `docker compose logs -f` — controleer op eventuele `plugins: kon ... niet parsen`-warnings.
