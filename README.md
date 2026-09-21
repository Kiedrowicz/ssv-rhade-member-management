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
optional einmalig einspielen:
```
mysql -h 127.0.0.1 -P 3308 -u ssv_members -p ssv_member_management < db/01-seed-data.sql
```

## Produktion

`docker-compose.yml` baut die App und verbindet sie über das externe
Docker-Netzwerk `ssv-shared` mit dem travel-expenses-MariaDB-Container
(`ssv-travel-mariadb:3306`) — kein eigener `mariadb`-Service. Voraussetzung:
Netzwerk `ssv-shared` existiert bereits und der travel-expenses-Stack läuft.
`.env` mit `DB_PASSWORD` und `JWT_SECRET` muss vor `docker-compose up -d`
vorhanden sein. Ein `scripts/setup-vps.js` für automatisiertes
VPS-Deployment gibt es noch nicht — folgt, sobald die App tatsächlich aufs
VPS soll (siehe CLAUDE.md).

## Aktueller Funktionsumfang

- Mitglieder anlegen/bearbeiten (Stammdaten landen in
  `ssv_shared_members.players`, direkt sichtbar auch für travel-expenses)
- Mitgliedschaftsstatus, Ein-/Austrittsdatum, Mitgliedsnummer
- Beitragsklassen verwalten
- Ämter/Funktionen je Mitglied
- Erziehungsberechtigte für minderjährige Mitglieder
- Beitragsfälligkeiten je Mitglied und Jahr, Zahlungsstatus, sowie
  automatisches Generieren offener Fälligkeiten für ein Jahr

**Bewusst nicht enthalten** (siehe CLAUDE.md): automatisierter
Mahnwesen-Mailversand, PDF-Export von Beitragsbescheiden,
Mitglieder-Self-Service-Login.
