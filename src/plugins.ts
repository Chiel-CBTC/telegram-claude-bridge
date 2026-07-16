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

  try {
    const excluded = new Set(excludedNames);
    const paths = new Set<string>();

    for (const [key, entries] of Object.entries(parsed.plugins ?? {})) {
      const pluginName = key.split('@')[0];
      if (excluded.has(pluginName)) {
        continue;
      }
      if (!Array.isArray(entries)) {
        continue;
      }
      for (const entry of entries) {
        if (entry && typeof entry === 'object' && entry.installPath) {
          paths.add(entry.installPath);
        }
      }
    }

    return [...paths].map((path) => ({ type: 'local' as const, path }));
  } catch {
    console.warn(
      `plugins: onverwachte structuur in ${installedPluginsPath}, laad geen plugins`
    );
    return [];
  }
}
