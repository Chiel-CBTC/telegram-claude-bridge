# Telegram ↔ Claude Code Bridge — Design

Datum: 2026-07-12

## Doel

Chiel wil vanaf zijn telefoon via Telegram kunnen communiceren met een Claude-agent die op deze server draait — als algemene coding/serverassistent onderweg, vergelijkbaar met een interactieve Claude Code-sessie, maar dan via Telegram als interface in plaats van een terminal.

## Scope

- Eén Telegram-bot, alleen bruikbaar door Chiel (geen multi-user ondersteuning).
- Eén doorlopende Claude-sessie per Telegram-chat, met geheugen tussen berichten.
- Werkmap standaard `/home/chiel` (dezelfde brede toegang als een interactieve Claude Code-sessie op deze server).
- Risicovolle acties vereisen expliciete goedkeuring via Telegram-knoppen voordat ze worden uitgevoerd.
- Draait als eigen Docker-container op deze server.

Buiten scope (bewust, voor een latere iteratie indien gewenst): multi-user support, webhook-gebaseerde Telegram-integratie (i.p.v. long polling), geautomatiseerde test-suite, notificaties/proactieve pushes vanuit Claude zelf (dit ontwerp is gericht op door Chiel geïnitieerde interactie).

## Architectuur

Eén Node.js/TypeScript-service in een Docker-container, met twee kerncomponenten:

1. **Telegram-laag** (`telegraf`, long polling) — ontvangt berichten van Chiel, stuurt Claude's antwoorden terug, toont inline-knoppen ("Goedkeuren"/"Weigeren") bij risicovolle acties, toont een "typing…"-indicator tijdens verwerking.
2. **Claude-laag** (Claude Agent SDK) — draait dezelfde agent-harness als Claude Code (Read/Write/Edit/Bash/Glob/Grep/WebSearch/WebFetch), aangestuurd vanuit code zodat een `canUseTool`-hook risicovolle tool-calls kan onderscheppen en laten pauzeren tot Chiel via Telegram akkoord geeft.

Long polling is gekozen boven een webhook omdat er geen publieke HTTPS-endpoint nodig is — geen extra open poort op de server.

## Sessiebeheer

- Per Telegram `chat.id` wordt één Claude-sessie-ID bijgehouden in een lokaal bestand (`data/sessions.json`, buiten git).
- Nieuwe berichten in een bestaande chat hervatten die sessie (via de Agent SDK's sessie-resumption), zodat context behouden blijft.
- Een `/reset`-commando in Telegram start een verse sessie voor die chat (nieuwe sessie-ID, oude blijft staan maar wordt niet meer gebruikt).
- Een bot-herstart (crash/redeploy) verliest het gesprek niet, omdat de sessie-mapping op disk staat. Een op dat moment openstaande goedkeuringsvraag vervalt wel — de agent moet die actie na herstart opnieuw voorstellen.

## Permissie-flow (goedkeuring van risicovolle acties)

Wanneer Claude een tool wil gebruiken die als risicovol is aangemerkt, pauzeert de `canUseTool`-hook de uitvoering en stuurt de bot een Telegram-bericht met:
- een korte omschrijving van de voorgestelde actie (bv. het exacte bash-commando),
- twee inline-knoppen: **Goedkeuren** en **Weigeren**.

De agent wacht op een reactie, met een timeout van 15 minuten. Bij het verstrijken van de timeout wordt de actie automatisch geweigerd en ontvangt Chiel een melding dat dit is gebeurd.

### Classificatie: automatisch toegestaan vs. vraagt bevestiging

Sluit aan bij hoe Claude Code nu al standaard met risico omgaat in interactieve sessies:

**Automatisch toegestaan:**
- Bestanden lezen, bewerken, aanmaken binnen `/home/chiel`
- Tests draaien, build-commando's, algemene read-only bash-commando's
- Lokale git-commits (staging + commit, geen push)

**Vraagt bevestiging via Telegram:**
- `git push` (elke vorm)
- `git reset --hard`, `git clean -f`, `git checkout --` op ongecommit werk
- `rm -rf` en vergelijkbare destructieve verwijderingen
- Commando's met `sudo`
- Force-flags in het algemeen (`--force`, `-f` bij destructieve commando's)
- Elke actie die buiten `/home/chiel` schrijft

Deze classificatie wordt geïmplementeerd als een lijst van patronen/regex in `src/riskRules.ts` — een startpunt dat Chiel later kan aanscherpen zonder de rest van de code te wijzigen.

## Beveiliging

- De bot reageert uitsluitend op berichten van Chiel's eigen Telegram user-ID. Dit ID wordt bij het opstarten uit configuratie gelezen (whitelist van precies één ID); berichten van elke andere afzender worden genegeerd (geen antwoord, geen logging van inhoud anders dan "genegeerd: onbekende afzender").
- Bot-token, toegestane user-ID en Anthropic-credentials staan in een `.env`-bestand dat niet in git wordt opgenomen (`.gitignore`).
- De Claude-agent draait met dezelfde bestandssysteemrechten als de container-gebruiker; er is geen extra sandboxing bovenop wat de permissie-classificatie hierboven afdwingt.

## Authenticatie richting Anthropic

De Agent SDK in de container heeft eigen credentials nodig, los van Chiel's interactieve `claude`-login op de host. Voorkeur: een `ANTHROPIC_API_KEY` in `.env`. Alternatief (indien gewenst tijdens implementatie): een gemount `ant auth login`-profiel. Dit wordt verder uitgewerkt in het implementatieplan — vereist een keuze/actie van Chiel (API-key aanmaken of profiel beschikbaar stellen).

## Repo- en projectstructuur

Nieuwe repo: `~/git/telegram-claude-bridge`.

```
telegram-claude-bridge/
├── src/
│   ├── bot.ts            # Telegram-laag (telegraf)
│   ├── claudeSession.ts  # Agent SDK-integratie, sessiebeheer per chat
│   ├── approvals.ts      # canUseTool-hook + pending-approval state
│   ├── riskRules.ts      # patronen voor "vraagt bevestiging"
│   └── config.ts         # env-vars laden/valideren
├── data/                  # sessie-mapping (chatId -> sessionId), genegeerd in git
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .gitignore
└── README.md              # incl. BotFather-stappen
```

Deployment: `docker-compose up -d`, restart-policy `unless-stopped`, zichtbaar/beheerbaar via Portainer naast de bestaande containers.

## Foutafhandeling

- **Claude-fouten** (API-fout, rate limit, crash tijdens tool-uitvoering): worden opgevangen en resulteren in een duidelijke foutmelding naar Telegram, niet in een stille hang of crash van de bot.
- **Telegram-berichtlimiet** (4096 tekens): langere antwoorden van Claude worden automatisch opgeknipt in meerdere opeenvolgende berichten.
- **Lange taken**: Telegram toont een "typing…"-indicator zolang Claude bezig is.

## Testen

Geen geautomatiseerde test-suite voor deze integratie — verificatie gebeurt door de bot lokaal te draaien en handmatig te doorlopen:
- gewoon bericht sturen en antwoord ontvangen,
- een risicovolle actie triggeren en zowel goedkeuren als weigeren testen,
- `/reset` testen (nieuwe sessie, geen geheugen van daarvoor),
- gedrag bij bericht van een niet-toegestane afzender (genegeerd),
- bot-herstart met een lopende sessie (geheugen blijft behouden).

## Open punten voor het implementatieplan

- Definitieve keuze Anthropic-authenticatie (API key vs. gemount profiel).
- Exacte regex-patronen in `riskRules.ts` (startlijst, verder aan te scherpen na gebruik).
- Welk Claude-model de agent standaard gebruikt (voorstel: een actueel Sonnet-model, te bevestigen bij implementatie).
- BotFather-stappen om het bot-token te verkrijgen (wordt interactief met Chiel doorlopen bij implementatie).
