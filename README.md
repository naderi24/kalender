# Kalender

En enkel personlig kalender i stil med iPhones egen (Liquid Glass). Kursschemat (föreläsningar, seminarier för din grupp, inlämningar, tentor) laddas automatiskt, och du lägger till, ändrar och flyttar egna händelser. Andra kalendrar kopplas in med kalenderlänkar. En AI-assistent kan göra ändringar och hitta lediga tider.

Vyer: lista, dag, flera dagar (tre på mobilen, hela veckan på större skärmar) och månad. Svep i sidled för att bläddra. Tryck på en händelse för att se detaljer.

Appen är en statisk webbsida utan byggsteg. Lägg den på hemskärmen i Safari (Dela → Lägg till på hemskärmen) så öppnas den i helskärm.

## Filer

- `index.html`, `styles.css`, `app.js`: appen.
- `sync.js`: synk mellan enheter genom ett privat GitHub-repo.
- `ics.js`: läser kalenderfiler (ICS) för kalenderlänkarna, med upprepningar och tidszoner.
- `tools/data-repo/`: två GitHub Actions-jobb som hör hemma i datarepot och hämtar kalenderlänkar (se nedan).
- `ai.js`: assistenten. Den använder din egen Anthropic-nyckel, som bara sparas i webbläsaren på enheten.
- `data/schedule.json`: kursschemat med alla seminariegruppers tider.
- `vendor/anthropic-sdk.js`: Anthropics SDK, buntad till en fil.
- `sw.js`, `manifest.webmanifest`, `icon-*.png`: hemskärmsapp och offline-stöd.

## Uppdatera schemat

Schemat byggs från tidtabellerna i SSE Trainers (`courses/<kurs>/js/c-schedule.js`):

```bash
node tools/build_schedule.mjs <mapp med courses/...>
```

Ändringar som har gjorts i Canvas efter att SSE Trainers hämtade schemat (oftast salsbyten) står i `tools/canvas_updates.json` och läggs på automatiskt när schemat byggs. Varje rad anger kurs, händelse, grupp och ny sal eller tid, och filen har ett datum för när den senast kontrollerades mot Canvas.

Publicera sedan `data/schedule.json`. Appen hämtar den nya filen nästa gång den öppnas. Egna ändringar av schemahändelser ligger kvar.

## Bunta om SDK:t

```bash
npm install @anthropic-ai/sdk esbuild
printf 'import Anthropic from "@anthropic-ai/sdk";\nimport { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";\nexport { Anthropic, betaTool };\n' > entry.mjs
npx esbuild entry.mjs --bundle --format=esm --minify --platform=browser --target=es2020 --outfile=vendor/anthropic-sdk.js
```

## Data

Egna händelser, vald grupp och ändringar sparas i webbläsarens lagring på varje enhet. Under Kalendrar finns export och import av en säkerhetskopia.

## Synk mellan enheter

Synken är frivillig och slås på under Kalendrar → Synk. Kalendern sparas då som filen `kalender.json` i ett privat repo som heter `kalender-data` på ditt eget GitHub-konto, och varje enhet läser och skriver den filen.

Så här kopplar du en enhet:

1. Repot `kalender-data` ska finnas på ditt konto och vara privat.
2. Tryck på Synka mellan enheter i appen och sedan Öppna GitHub. Länken öppnar formuläret för en fine-grained token med Contents: Read and write förvalt.
3. Välj ”Only select repositories” och `kalender-data`, tryck Generate token och klistra in nyckeln i appen.

Nyckeln sparas bara i webbläsaren på enheten (`kalender-sync` i localStorage) och kommer bara åt det repot.

Så fungerar det: varje händelse, schemaändring, kalender och inställning har en tidsstämpel för när den senast ändrades. Enheterna slår ihop sina kopior post för post och den senaste ändringen vinner. Raderade poster ligger kvar som markeringar så att en gammal enhet inte kan väcka dem till liv. Ändringar skickas ett par sekunder efter att de görs, och appen hämtar andras ändringar när den öppnas och ungefär en gång i minuten. Varje sparning blir en commit i `kalender-data`, så historiken fungerar också som säkerhetskopia. Utseende, vald vy och AI-nyckeln synkas inte.

## Kalenderlänkar

Under Kalendrar → Lägg till kalenderlänk klistrar du in en prenumerationslänk (ICS eller webcal) från till exempel Google Kalender, Outlook, Canvas eller TimeEdit. Händelserna visas som en egen kalender som bara går att läsa, och hämtas om ungefär varje halvtimme medan appen är öppen.

De flesta kalendertjänster låter inte en webbsida läsa deras filer direkt. Appen provar först direkt, och läser annars en kopia ur datarepot `kalender-data` (kräver att synk är på):

1. Appen skriver listan över länkar till `feeds.json` i datarepot.
2. Jobbet `feeds-switch.yml` märker ändringen och startar `feeds.yml`.
3. `feeds.yml` laddar ner varje länk till `feeds/<id>.ics`, varannan timme så länge det finns länkar. När listan är tom stänger jobbet av sig självt.

Installera jobben genom att lägga de två filerna i `tools/data-repo/` i datarepots mapp `.github/workflows/`. De använder GitHub Actions-minuter i ett privat repo: ungefär en minut per körning, alltså runt 370 minuter i månaden när minst en länk är inkopplad (gratiskvoten är 2 000). Länkarna är hemliga adresser och finns bara i webbläsaren och i det privata datarepot.

## Importera händelser

Under Kalendrar → Importera händelser klistrar du in text från en kalenderfil (den börjar med `BEGIN:VCALENDAR`) eller väljer en `.ics`-fil. Händelserna läggs i en av dina egna kalendrar och går att ändra som vanligt. Upprepade händelser läggs in som enskilda tillfällen ungefär ett år framåt. Importerar du samma sak igen uppdateras händelserna i stället för att dubbleras.

## Inställningar

Kugghjulet öppnar inställningarna: utseende (ljust, mörkt, accentfärg), veckans första dag, veckonummer, startvy, antal dagar i veckovyn, 24-timmarsklocka, när dagen börjar, radhöjd, längd och kalender för nya händelser, synk, AI-nyckel och säkerhetskopia. De gäller enheten och synkas inte.
