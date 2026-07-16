# Telegram ↔ Claude Code Bridge

Chat with a Claude agent running on this server, from Telegram.

## Setup

1. Create a bot via [@BotFather](https://t.me/BotFather): `/newbot`, choose a name and
   username, copy the API token it gives you.
2. Get your own Telegram user ID from [@userinfobot](https://t.me/userinfobot).
3. `cp .env.example .env` and fill in `TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM_USER_ID`,
   and `ANTHROPIC_API_KEY`.
4. `docker compose up -d --build`

## Usage

- Send any message to chat with Claude. Context is kept per Telegram chat until you send `/reset`.
- When Claude wants to do something risky (`git push`, `rm -rf`, `sudo`, writing outside
  `/home/chiel`, piping a downloaded script into a shell, reading/writing `.env`/`.pem`/SSH
  key files, ...), it sends an approval request with **Goedkeuren**/**Weigeren** buttons
  and waits up to 15 minutes before auto-denying.
- Only the Telegram user ID in `ALLOWED_TELEGRAM_USER_ID` can use the bot — everyone else is
  silently ignored.

## Adjusting risk rules

Edit `src/riskRules.ts` to change which Bash command patterns or file paths require
confirmation, then rebuild: `docker compose up -d --build`.

## Notion access (optional)

To let the bot read/write your Notion workspace:

1. Create an internal integration at [notion.so/my-integrations](https://www.notion.so/my-integrations)
   and copy its token (starts with `ntn_`).
2. In Notion, open each page or database you want the bot to reach, and share it with that
   integration (`···` menu → Connections → add your integration). The bot only sees what's
   explicitly shared — unlike your own claude.ai Notion connector, this token has no implicit
   access to your whole workspace.
3. Set `NOTION_TOKEN` in `.env`.
4. `docker compose up -d --build`

This runs the official `@notionhq/notion-mcp-server` as a local stdio process inside the
container — no OAuth flow, independent of your claude.ai account's own Notion connection.

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

## Logs

```bash
docker compose logs -f
```
