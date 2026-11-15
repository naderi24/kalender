# Kalender

En enkel personlig kalender i stil med iPhones egen. Kursschemat (föreläsningar, seminarier för din grupp, inlämningar, tentor) laddas automatiskt, och du lägger till, ändrar och flyttar egna händelser. En AI-assistent kan göra ändringar och hitta lediga tider.

Appen är en statisk webbsida utan byggsteg. Lägg den på hemskärmen i Safari (Dela → Lägg till på hemskärmen) så öppnas den i helskärm.

## Filer

- `index.html`, `styles.css`, `app.js`: appen.
- `ai.js`: assistenten. Den använder din egen Anthropic-nyckel, som bara sparas i webbläsaren på enheten.
- `data/schedule.json`: kursschemat med alla seminariegruppers tider.
- `vendor/anthropic-sdk.js`: Anthropics SDK, buntad till en fil.
- `sw.js`, `manifest.webmanifest`, `icon-*.png`: hemskärmsapp och offline-stöd.

## Uppdatera schemat

Schemat byggs från tidtabellerna i SSE Trainers (`courses/<kurs>/js/c-schedule.js`):

```bash
node tools/build_schedule.mjs <mapp med courses/...>
```

Publicera sedan `data/schedule.json`. Appen hämtar den nya filen nästa gång den öppnas. Egna ändringar av schemahändelser ligger kvar.

## Bunta om SDK:t

```bash
npm install @anthropic-ai/sdk esbuild
printf 'import Anthropic from "@anthropic-ai/sdk";\nimport { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";\nexport { Anthropic, betaTool };\n' > entry.mjs
npx esbuild entry.mjs --bundle --format=esm --minify --platform=browser --target=es2020 --outfile=vendor/anthropic-sdk.js
```

## Data

Egna händelser, vald grupp och ändringar sparas i webbläsarens lagring på varje enhet. Under Kalendrar finns export och import av en säkerhetskopia.
