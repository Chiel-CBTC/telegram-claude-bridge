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
  `/home/chiel`, ...), it sends an approval request with **Goedkeuren**/**Weigeren** buttons
  and waits up to 15 minutes before auto-denying.
- Only the Telegram user ID in `ALLOWED_TELEGRAM_USER_ID` can use the bot — everyone else is
  silently ignored.

## Adjusting risk rules

Edit `src/riskRules.ts` to change which Bash command patterns or file paths require
confirmation, then rebuild: `docker compose up -d --build`.

## Logs

```bash
docker compose logs -f
```
