# Plugins/skills beschikbaar maken in de Telegram-bot — Design

Datum: 2026-07-16

## Doel

Chiel wil dat de Claude-sessie die via de Telegram-bot draait dezelfde skills/plugins tot
haar beschikking heeft als een interactieve Claude Code-sessie in de terminal — en dat
nieuwe plugins of updates via de plugin marketplace (zoals hij die nu al in de terminal
gebruikt) automatisch doorwerken naar de bot, zonder dat hij een aparte kopie moet
onderhouden.

## Achtergrond / bestaande situatie

- De bot draait de Claude Agent SDK met `settingSources: []`, bewust ingesteld om de
  eigen `canUseTool`-goedkeuringsflow niet te laten omzeilen door instellingen uit
  `~/.claude/settings.json` (zie `src/claudeSession.ts`). Elke uitbreiding van de bot
  moet die isolatie intact laten.
- `docker-compose.yml` bind-mount't `/home/chiel:/home/chiel` in de container en zet
  `HOME=/home/chiel`. De container ziet dus dezelfde `~/.claude/plugins/...`-structuur
  als de host — geen aparte distributie van pluginbestanden nodig.
- De Agent SDK ondersteunt via de `plugins`-optie van `query()` alleen lokale plugins
  (`{ type: 'local', path: '...' }`); er is geen directe "laad vanaf marketplace X"-optie.
  De marketplace-CLI (hier in de terminal gebruikt) beheert echter zelf al een lokale
  cache onder `~/.claude/plugins/cache/...` en houdt de actuele paden bij in
  `~/.claude/plugins/installed_plugins.json`. Door dat bestand te lezen kan de bot altijd
  de actuele, door de marketplace beheerde plugin-paden gebruiken.
- Onderzoek van de 6 momenteel geïnstalleerde plugins (`chiel-skills`, `caveman`,
  `superpowers`, `skill-creator`, `impeccable`, `claude-plugins-zwijsen`) laat zien dat
  geen enkele ervan eigen permissie- of MCP-server-configuratie meeneemt die de
  `canUseTool`-gate zou kunnen omzeilen. Alleen `caveman` definieert hooks
  (`SessionStart`, `UserPromptSubmit`), en die zijn puur cosmetisch/logging van aard.
- `caveman` activeert wél by default caveman-spreekstijl bij sessiestart, en schrijft een
  modus-vlag naar `~/.claude/.caveman-active` — hetzelfde bestand dat ook terminal-sessies
  op deze machine delen. Dat is een verrassingsbron: caveman-mode wisselen via Telegram
  zou (ongewild) ook de terminal-caveman-mode beïnvloeden, en andersom.

## Scope

- Alle overige geïnstalleerde plugins standaard beschikbaar maken in de bot; `caveman`
  standaard uitgesloten vanwege bovenstaande gedeelde-state-verrassing.
- Een uitsluitlijst die Chiel zelf kan aanpassen via `.env`, zonder codewijziging.
- De pluginlijst wordt bij elk Telegram-bericht opnieuw ingelezen (niet gecachet bij
  opstarten), zodat `/plugin update`/`/plugin install` in de terminal direct doorwerkt
  zonder dat de bot herstart hoeft te worden.
- Buiten scope: een eigen UI/commando in Telegram om plugins aan/uit te zetten (dat blijft
  via `.env` + herstart van de container, net als `NOTION_TOKEN`); ondersteuning voor
  niet-lokale plugin-types (de SDK biedt die nu niet aan).

## Architectuur

Nieuwe module `src/plugins.ts` met één functie:

```
loadPluginConfigs(installedPluginsPath: string, excludedNames: readonly string[]): SdkPluginConfig[]
```

- Leest `installed_plugins.json` (formaat: `{ plugins: { "<naam>@<marketplace>": [{ installPath, scope, ... }] } }`).
- Voor elke key wordt het deel vóór `@` als plugin-naam gebruikt om tegen `excludedNames`
  te matchen.
- Voor elke niet-uitgesloten plugin wordt elke `installPath` uit de entry-array omgezet
  naar `{ type: 'local', path: installPath }`.
- Ontbreekt het bestand, of is het onleesbaar/kapotte JSON: geeft een lege array terug
  (geen crash) — zelfde "fail open naar niks"-patroon als `notionToken` nu al heeft voor
  Notion-toegang. Een kapotte-JSON-geval logt een `console.warn` voor debugbaarheid; een
  ontbrekend bestand niet (verwacht in test/CI-omgevingen zonder plugins).

In `src/claudeSession.ts`:

- `createClaudeSessionRunner` berekent eenmalig het pad naar `installed_plugins.json`
  (`path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json')`).
- `sendMessageNow` roept `loadPluginConfigs(...)` bij elk bericht opnieuw aan (verse read,
  geen caching) en geeft het resultaat als `plugins`-optie mee aan `query()`, naast en los
  van `settingSources: []`.

In `src/config.ts`:

- Nieuw veld `excludedPlugins: string[]`, gevuld vanuit env var `EXCLUDED_PLUGINS`
  (komma-gescheiden pluginnamen). Standaard (var niet gezet): `['caveman']`. Expliciet op
  leeg gezet (`EXCLUDED_PLUGINS=`): geen uitsluitingen, ook `caveman` niet.

## Permissie-isolatie

Dit blijft ongewijzigd: `settingSources: []` blijft staan, `plugins` is een apart
SDK-optie-veld dat geen instellingen/permissies uit `~/.claude/settings.json` leest. De
`canUseTool`-hook blijft de enige autoriteit over tool-uitvoering, ook voor tools/skills
die via plugins worden aangeboden.

## Testen

- Unit tests voor `loadPluginConfigs` in `tests/plugins.test.ts`, volgens het bestaande
  patroon (expliciet pad injecteren i.p.v. intern `os.homedir()` aanroepen, zodat de
  functie zonder filesystem-mocking te testen is via een tijdelijk testbestand):
  - ontbrekend bestand → lege array.
  - kapotte JSON → lege array, geen throw.
  - uitsluitlijst filtert de juiste plugin-naam (vóór de `@`) eruit.
  - meerdere `installPath`-entries per plugin-key worden allemaal meegenomen.
  - lege `excludedNames` (of weggelaten) sluit niets uit.
- Config-tests in `tests/config.test.ts` uitbreiden: default `excludedPlugins` is
  `['caveman']`, custom `EXCLUDED_PLUGINS` wordt correct gesplitst/getrimd, lege string
  geeft lege array.

## Documentatie

- README: nieuwe sectie over plugins/skills in de bot — hoe het werkt (leest dezelfde
  marketplace-cache als de terminal), hoe je `EXCLUDED_PLUGINS` instelt, en de
  caveman-waarschuwing (gedeelde modus-state met de terminal als je hem alsnog meeneemt).
- `.env.example`: nieuwe optionele `EXCLUDED_PLUGINS`-regel met toelichting en het
  `caveman`-default genoemd.
