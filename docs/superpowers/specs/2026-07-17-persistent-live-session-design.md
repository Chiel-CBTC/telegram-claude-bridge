# Persistent live Claude session per Telegram-chat — Design

Datum: 2026-07-17

## Doel

De bot voelt traag aan ("KITT is traag met antwoorden"). Gemeten oorzaak: `src/claudeSession.ts`
start bij **elk** Telegram-bericht een volledig nieuwe `query()`-call (nieuw `claude`-subprocess +
nieuwe Notion-MCP-subprocess + herinlezen van plugins/skills), in plaats van één sessie te laten
doorlopen over de hele conversatie. Dit ontwerp maakt de sessie **persistent binnen een gesprek**:
één levend proces per chat, hergebruikt over opeenvolgende berichten, met een gemeten
kosten/batenafweging voor de gekozen aanpak.

## Achtergrond / metingen

- Elk Telegram-bericht roept vandaag `query({ prompt: userMessage, options: { resume: sessionId, ... } })`
  aan — een one-shot call die bij voltooiing het onderliggende proces laat eindigen. Het
  eerstvolgende bericht in dezelfde chat start alles opnieuw op.
- Twee concrete, gemeten kostenposten van die aanpak:
  - De Notion-MCP-server wordt gestart via `npx -y @notionhq/notion-mcp-server`. Gemeten:
    **~2,2s** puur npx-resolutieoverhead per bericht, ook al staat het package al lokaal
    geïnstalleerd. (Los daarvan een snelle, onafhankelijke fix: direct
    `node node_modules/@notionhq/notion-mcp-server/bin/cli.mjs` aanroepen scheelt ~1,6s per
    bericht — dit ontwerp maakt die fix grotendeels overbodig omdat de MCP-server straks nog maar
    één keer per gesprek opstart, maar de bypass blijft de moeite waard voor de koude-start-kosten
    die dit ontwerp niet wegneemt.)
  - Sinds de plugin/skill-feature (vorige sessie) worden bij elk bericht ~343 bestanden over
    5 plugins van schijf gelezen/geparsed. Kleinere kostenpost dan de MCP-server, maar ook per
    bericht herhaald.
- Geheugenmeting van één volledige sessie (gelijke configuratie als productie: model, Notion MCP,
  `settingSources: []`):

  | Proces | RSS |
  |---|---|
  | `claude`-subprocess | ~276 MB |
  | `npm exec` (npx-wrapper) | ~91 MB |
  | `notion-mcp-server` | ~92 MB |
  | **Totaal** | **~460 MB** |

  Ter referentie: de bot zelf (Telegraf/Node, idle) gebruikt nu ~837 MB op deze host. De host heeft
  11 GiB RAM maar staat al op ~5,4 GiB swap-gebruik — er is dus al geheugendruk, wat een **permanent**
  actief proces een reëel risico maakt.
- De Agent SDK ondersteunt naast het huidige one-shot gebruik (`prompt: string`) ook een
  **streaming-input-modus** (`prompt: AsyncIterable<SDKUserMessage>`), waarbij één `query()`-call
  het onderliggende proces levend houdt en meerdere beurten achter elkaar verwerkt zonder opnieuw
  op te starten. `SDKSystemMessage` (subtype `'init'`) bevat een `session_id`-veld, dus die kan
  direct bij sessiestart gepersisteerd worden (niet pas bij het eerste `result`, zoals nu).

## Scope

- Gebruik is beperkt tot één Telegram-gebruiker en in de praktijk één actieve chat (bevestigd door
  Chiel) — het ontwerp hoeft niet te schalen naar veel gelijktijdige chats, al blijft de structuur
  (map van `chatId` naar sessie) consistent met de rest van de codebase (`sessionStore`,
  `perKeySerializer`, `approvalBroker` werken allemaal al zo).
- Plugins/skills worden **niet** meer bij elk bericht ververst zolang een sessie leeft — dat gebeurt
  alleen nog bij `/reset` of een koude herstart (idle-close of container-restart), want een nieuw
  proces leest ze sowieso altijd opnieuw in. Dit is een bewuste afwijking van de vorige sessie's
  "live per bericht"-keuze, geaccepteerd door Chiel voor de snelheidswinst.
- Idle-timeout: een sessie zonder nieuw bericht binnen **30 minuten** wordt netjes afgesloten
  (geheugen vrijgegeven); het eerstvolgende bericht daarna betaalt eenmalig weer de volledige
  opstartkosten (zoals vandaag altijd het geval is), maar sluit via `resume` aan op het bestaande
  gesprek.
- Buiten scope: ondersteuning voor meerdere gelijktijdige chats met elk een eigen levend proces
  (niet nodig, kan later alsnog werken via dezelfde per-`chatId`-structuur); configureerbare
  plugin-verversing binnen een levende sessie (bewust simpel gehouden — alleen bij `/reset`/herstart).

## Architectuur

Nieuwe module **`src/liveSession.ts`** beheert een live sessie per chat:

- Een kleine **push-wachtrij** (`AsyncPushQueue<T>`) implementeert `AsyncIterable<T>` met
  `push(item: T): void` en `close(): void`. Deze wordt als `prompt` aan `query()` meegegeven.
- Een **achtergrond-leeslus** consumeert de doorlopende `Query`-outputstream (een
  `AsyncGenerator<SDKMessage>`), bundelt `assistant`-tekstblokken per beurt, en levert bij een
  `result`-bericht de gebundelde tekst terug aan de wachtende `sendMessage()`-aanroeper.
- Een **idle-timer** per sessie (30 min, herstart na elke voltooide beurt) sluit de wachtrij
  netjes (EOF-signaal → de SDK's eigen gracieuze afsluitpad, ~2s) en verwijdert de sessie uit de
  live-map zodra hij afloopt.

`src/claudeSession.ts` blijft de buitenkant (`ClaudeSessionRunner.sendMessage`/`resetSession`),
maar delegeert de daadwerkelijke uitvoering aan `liveSession.ts` in plaats van zelf een one-shot
`query()`-call te doen. `settingSources: []`, `canUseTool`/goedkeuringsflow, `disallowedTools`, de
per-chat `perKeySerializer` en `sessionStore` (voor `resume` na een koude start) blijven ongewijzigd
van gedrag.

## Componenten

### `src/liveSession.ts` (nieuw)

```ts
export interface LiveSessionManager {
  sendMessage(chatId: number, userMessage: string): Promise<string>;
  closeSession(chatId: number): void;
  closeAll(): void;
}

export interface CreateLiveSessionManagerDeps {
  workingDir: string;
  model: string;
  sessionStore: SessionStore;
  approvalBroker: ApprovalBroker;
  notifyApprovalNeeded: (chatId: number, approval: { id: string; description: string }) => void;
  notionToken?: string;
  excludedPlugins?: string[];
  idleTimeoutMs: number;
}

export function createLiveSessionManager(deps: CreateLiveSessionManagerDeps): LiveSessionManager;
```

Intern (niet geëxporteerd):

```ts
interface AsyncPushQueue<T> extends AsyncIterable<T> {
  push(item: T): void; // throws if called after close()
  close(): void; // idempotent — closing an already-closed queue is a no-op
}

interface LiveSession {
  queue: AsyncPushQueue<SDKUserMessage>;
  queryHandle: Query; // van @anthropic-ai/claude-agent-sdk
  pendingTurns: Array<{ resolve: (text: string) => void; reject: (err: unknown) => void }>;
  idleTimer: ReturnType<typeof setTimeout>;
  closed: boolean;
}
```

`function toSDKUserMessage(text: string): SDKUserMessage` bouwt een streaming-inputbericht:

```ts
{
  type: 'user',
  message: { role: 'user', content: text }, // MessageParam uit @anthropic-ai/sdk/resources
  parent_tool_use_id: null,
}
```

### `src/claudeSession.ts` (gewijzigd)

`createClaudeSessionRunner` bouwt nu een `LiveSessionManager` (via `createLiveSessionManager`) en
delegeert:

```ts
sendMessage(chatId, userMessage) {
  return messageQueue.run(chatId, () => liveSessionManager.sendMessage(chatId, userMessage));
}

resetSession(chatId) {
  liveSessionManager.closeSession(chatId);
  deps.sessionStore.reset(chatId);
}
```

De `perKeySerializer` blijft op dit niveau zitten — hij serialiseert nu "push + wacht op deze
beurt" in plaats van "voer een hele one-shot call uit", maar de garantie (nooit twee gelijktijdige
aanroepen voor dezelfde chat) blijft hetzelfde en is precies wat de turn-correlatie in
`liveSession.ts` veilig maakt (geen race tussen twee gelijktijdige "wacht op het eerstvolgende
`result`"-registraties).

### `src/config.ts` (gewijzigd)

Nieuw veld, zelfde patroon als het bestaande `approvalTimeoutMs`:

```ts
export interface Config {
  // ...bestaande velden...
  liveSessionIdleTimeoutMs: number;
}
```

```ts
liveSessionIdleTimeoutMs: env.LIVE_SESSION_IDLE_TIMEOUT_MS
  ? Number(env.LIVE_SESSION_IDLE_TIMEOUT_MS)
  : 30 * 60 * 1000,
```

### `src/index.ts` (gewijzigd)

- `liveSessionIdleTimeoutMs: config.liveSessionIdleTimeoutMs` meegeven aan
  `createClaudeSessionRunner`.
- `SIGINT`/`SIGTERM`-handlers roepen voortaan ook `claudeSessionRunner`'s onderliggende
  `liveSessionManager.closeAll()` aan vóór `bot.stop(...)`, zodat levende processen een gracieus
  afsluitsignaal krijgen in plaats van abrupt te worden gekilld (tini ruimt zombies sowieso op,
  maar gracieus is netter en laat de CLI zelf opruimen).

## Data flow

- **Bericht 1** (koude start — na `/reset`, idle-close, of container-herstart): geen live sessie
  voor deze `chatId` → nieuwe `AsyncPushQueue` aanmaken, `toSDKUserMessage(userMessage)` erin
  pushen, `query({ prompt: queue, options: { resume: sessionStore.get(chatId), ...de rest zoals nu... } })`
  starten, leeslus opstarten. Zodra de `system`/`init`-boodschap binnenkomt: `session_id` direct
  naar `sessionStore.set(chatId, ...)` schrijven (eerder dan vandaag, dat pas bij `result`
  persisteert). Wachten op de eerste beurt se `result`.
- **Bericht 2..N** (proces nog warm): live sessie gevonden → `toSDKUserMessage(userMessage)` in de
  bestaande wachtrij pushen, idle-timer resetten, wachten op de eerstvolgende `result` — veilig
  correleerbaar dankzij de `perKeySerializer`-garantie dat berichten per chat nooit overlappen.
- **Idle-timeout verstrijkt**: `queue.close()` (EOF-signaal, SDK's eigen gracieuze afsluitpad),
  sessie uit de live-map verwijderen.
- **`/reset`**: `liveSessionManager.closeSession(chatId)` roept, als er een beurt in behandeling is,
  eerst `queryHandle.interrupt()` aan (breekt die beurt direct af — het levende proces stopt niet
  vanzelf simpelweg doordat de wachtrij sluit, zolang de CLI een beurt aan het verwerken is) en
  verwerpt de openstaande `pendingTurns`-entry met een "sessie is gereset"-fout, gevolgd door
  `queue.close()`. Is er geen beurt in behandeling, dan volstaat direct `queue.close()`. Daarna
  `sessionStore.reset(chatId)`, zoals vandaag.
- **Container-stop**: `closeAll()` sluit alle live sessies netjes af vóór het proces stopt.

## Foutafhandeling

- Crasht de leeslus midden in een beurt (het onderliggende `for await` gooit een fout): de
  bijbehorende `pendingTurns`-entry wordt verworpen met die fout (het bestaande
  "Er ging iets mis: ..."-pad in `bot.ts` vangt dit al op), de sessie wordt uit de live-map
  verwijderd. Geen automatische retry — het eerstvolgende bericht start gewoon koud, via `resume`.
- Race tussen een binnenkomend bericht en een net-verlopen idle-timer: de `closed`-vlag op
  `LiveSession` wordt gecontroleerd vóór een push; staat hij aan, dan wordt behandeld alsof er geen
  live sessie bestaat (nieuwe sessie starten), in plaats van te pushen in een wachtrij die al aan
  het sluiten is.
- Pusht/wacht-logica gebruikt geen losse timeout voor "wacht op resultaat" — de bestaande
  `handlerTimeout`/`approvalTimeoutMs`-grenzen in `bot.ts` en de goedkeuringsflow blijven de
  effectieve bovengrenzen, ongewijzigd door dit ontwerp.

## Testen

- **Goed unit-testbaar (TDD, vitest):**
  - `AsyncPushQueue`: push vóór en na dat een consument begint te itereren, meerdere pushes,
    `close()` beëindigt de iteratie correct, geen items verloren.
  - Turn-boundary-logica: gegeven een reeks nep-`SDKMessage`-objecten (assistant-tekstblokken
    gevolgd door een `result`), wordt de juiste tekst aan de juiste wachtende `pendingTurns`-entry
    toegekend, in de juiste volgorde.
  - Idle-timer-gedrag met vitest se fake timers: timer reset na elke voltooide beurt, sluit de
    wachtrij na de ingestelde duur, geen sluiting als er tussentijds nieuwe berichten binnenkomen.
  - `resetSession`/`closeSession`/`closeAll` roepen de juiste onderliggende afsluitacties aan
    (met een neppe/mock `LiveSession`-implementatie, geen echte SDK nodig).
  - `src/config.ts`: default `liveSessionIdleTimeoutMs` (30 min) en override via
    `LIVE_SESSION_IDLE_TIMEOUT_MS`, zelfde patroon als de bestaande `approvalTimeoutMs`-tests.
- **Niet zinvol unit-testbaar** (net als vandaag voor `claudeSession.ts`): de daadwerkelijke
  procesorkestratie — het echt spawnen van `query()` met een streaming `AsyncIterable`-prompt en
  het verwerken van de echte outputstream. Verificatie loopt via de bestaande
  `scripts/smoke-test-claude-session.ts` (uit te breiden met een scenario dat twee berichten na
  elkaar naar dezelfde chat stuurt en controleert dat het tweede antwoord vlot komt) en Chiel's
  eigen Telegram-gebruik na deploy.
