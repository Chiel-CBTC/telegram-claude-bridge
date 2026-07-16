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

## Skills/plugins in the bot

The bot automatically loads the same Claude Code skills/plugins you've installed here in the
terminal via the plugin marketplace (`~/.claude/plugins/installed_plugins.json`) — no separate
installation or sync needed. Add or update a plugin via `/plugin install`/`/plugin update` in
the terminal, and the bot picks it up automatically on the next message, without a rebuild.

Excluded by default: `caveman`. That plugin activates caveman speech mode by default at session
start and shares its mode flag (`~/.claude/.caveman-active`) with your terminal sessions on this
machine — including it in the bot could therefore affect your terminal's caveman mode and vice
versa.

Adjust the exclusion list via `EXCLUDED_PLUGINS` in `.env` (comma-separated plugin names, the
part before the `@` in `installed_plugins.json`), for example:

```
EXCLUDED_PLUGINS=caveman,impeccable
```

Set it explicitly to empty (`EXCLUDED_PLUGINS=`) to include `caveman` too. After changing
`.env`: `docker compose up -d --build`.

## Logs

```bash
docker compose logs -f
```
