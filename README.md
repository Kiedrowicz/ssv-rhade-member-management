# SSV Rhade – Mitgliederverwaltung

Eigenständige App für Mitgliederstammdaten, Ämter, Erziehungsberechtigte und
Beitragsverwaltung (Beitragsklassen, Fälligkeiten, Zahlungsstatus).

Nutzt bewusst dieselben Personen-/Mannschaftsdaten (`ssv_shared_members.players`
/ `.teams`) wie [ssv-rhade-travel-expenses](../ssv-rhade-travel-expenses),
statt sie zu duplizieren — siehe [CLAUDE.md](./CLAUDE.md) für die
Architekturentscheidungen dahinter.

## Voraussetzungen

- Node.js 20+
- Ein laufender MariaDB-Server mit der Datenbank `ssv_shared_members`
  (lokal: der `mariadb`-Container von travel-expenses, `docker-compose up
  mariadb` dort)

## Einmaliges Setup

1. travel-expenses' MariaDB muss laufen (lokal: `docker-compose up -d
   mariadb` im travel-expenses-Ordner, exponiert Port 3308).
2. Neuen DB-User + Datenbank anlegen — in
   [scripts/grant-db-user.sql](./scripts/grant-db-user.sql) zuerst das
   Passwort (`CHANGE-ME-vor-dem-Ausfuehren`) anpassen, dann:
   ```
   mysql -h 127.0.0.1 -P 3308 -u root -p < scripts/grant-db-user.sql
   ```
   (Root-Passwort siehe travel-expenses' `docker-compose.yml`,
   `MARIADB_ROOT_PASSWORD`.)
3. `.env` aus `.env.example` erstellen, `DB_PASSWORD` auf denselben Wert wie
   in Schritt 2 setzen, `JWT_SECRET` auf einen zufälligen Wert setzen.
4. `npm install`

## Lokale Entwicklung

```
npm start
```

Legt beim ersten Start automatisch alle Tabellen an (`db/00-schema.sql`,
wiederholbar) und erzeugt einen initialen Admin-Zugang — Benutzername und
zufälliges Passwort werden einmalig in die Konsole geloggt. Danach unter
<http://localhost:3000> erreichbar.

Beitragsklassen-Startdaten (Erwachsene, Jugend, Familie, Ehrenmitglied)
sowie die 5 Abteilungen (Outdoor, Indoor, Fußball, Tanzen, Tischtennis)
optional einmalig einspielen:
```
mysql -h 127.0.0.1 -P 3308 -u ssv_members -p < db/01-seed-data.sql
```
(`INSERT IGNORE`, also gefahrlos mehrfach ausführbar.)

## Produktion (VPS)

Läuft unter `https://members.ssv-rhade.de` auf demselben VPS wie
travel-expenses und mail-sorter, hinter deren gemeinsamem zentralem Caddy
(`/opt/ssv-caddy`, externes Docker-Netzwerk `ssv-shared`). Kein eigener
`mariadb`-Service — verbindet sich per Docker-DNS mit dem bereits
laufenden `ssv-travel-mariadb`-Container. DB-User `ssv_members` +
Datenbank `ssv_member_management` sowie die Seed-Daten (Beitragsklassen,
5 Abteilungen) sind dort bereits eingerichtet.

Redeploy nach Codeänderungen:
```
npm run setup-vps
```
Baut und startet den Container auf dem VPS neu, gleicht die gemeinsame
Caddyfile ab (ergänzt/aktualisiert nur die eigene Route, verändert fremde
Routen nicht, siehe `scripts/setup-vps.js`). Backup läuft über
travel-expenses' nächtlichen Cron-Job mit (`ssv_member_management` liegt
auf demselben MariaDB-Server).

Voraussetzung dafür in der lokalen `.env`: `VPS_HOST`/`VPS_USER`/
`VPS_PASSWORD` (derselbe VPS wie travel-expenses) sowie
`VPS_DB_PASSWORD`/`VPS_JWT_SECRET` (Produktionswerte, **nicht** identisch
mit den lokalen `DB_PASSWORD`/`JWT_SECRET` oben — siehe `.env.example`).

**Einmaliges Setup bei einer komplett neuen Installation** (DB-User +
Datenbank existieren noch nicht):
```
mysql -h <VPS> -P 3306 -u root -p < scripts/grant-db-user.sql
```
(Passwort darin zuvor anpassen, `DB_ROOT_PASSWORD` steht in
`/opt/ssv-travel-expenses/.env` auf dem VPS.) Danach `db/01-seed-data.sql`
einmalig gegen die VPS-DB einspielen (analog zur lokalen Anleitung oben).

**Wichtig bei Datenänderungen direkt per SQL gegen die Produktions-DB**
(z.B. Seed-Daten erneut einspielen): umgeht serverseitige Prüfungen wie
die Duplikat-Namens-Kontrolle der `team`-Action — siehe CLAUDE.md,
Abschnitt "Produktion (VPS)", für einen Vorfall, bei dem das zu einem
doppelten Eintrag geführt hat. Datenänderungen nach Möglichkeit über die
eigene API vornehmen.

## Aktueller Funktionsumfang

- Mitglieder anlegen/bearbeiten (Stammdaten landen in
  `ssv_shared_members.players`, direkt sichtbar auch für travel-expenses)
- Mitgliedschaftsstatus, Ein-/Austrittsdatum, Mitgliedsnummer
- Abteilungen/Teams als beliebig tiefe Baumstruktur verwalten (z.B.
  Fußball → Jugend → F1), Mitglieder können gleichzeitig mehreren
  Teams/Abteilungen angehören
- Beitragsklassen verwalten
- Ämter/Funktionen je Mitglied
- Erziehungsberechtigte für minderjährige Mitglieder
- Beitragsfälligkeiten je Mitglied und Jahr, Zahlungsstatus, sowie
  automatisches Generieren offener Fälligkeiten für ein Jahr

**Bewusst nicht enthalten** (siehe CLAUDE.md): automatisierter
Mahnwesen-Mailversand, PDF-Export von Beitragsbescheiden,
Mitglieder-Self-Service-Login.
