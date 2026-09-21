# Projektregeln für Claude & Codex

## Git-Workflow

- Neue Features und Fixes werden auf **Feature- bzw. Fix-Branches** entwickelt: `feature/name` oder `fix/name`
- Feature-/Fix-Branches werden per **PR in `develop`** gemerged
- `develop` ist der aktuelle Entwicklungsstand
- `main` ist immer ≤ develop — **main ist nie aktueller als develop**
- Wenn eine fertige neue Version bereit ist, wird `develop` per PR in `main` gemerged
- **Commits und Pushes auf Feature-Branches: autonom OK**
- **PRs erstellen und mergen: NUR auf explizite Freigabe durch den User**

## Branches

| Branch | Zweck |
|--------|-------|
| `main` | Produktions-Stand (geschützt) |
| `develop` | Aktueller Entwicklungsstand |
| `feature/...` | Neue Features |
| `fix/...` | Bugfixes |

## Gemeinsame Mitglieder-Datenbank (`ssv_shared_members`)

`teams` und `players` liegen in einer eigenen, App-übergreifenden Datenbank
(`ssv_shared_members`) auf demselben MariaDB-Server wie travel-expenses,
**nicht** in `ssv_member_management` selbst — sie wurde ursprünglich von
travel-expenses angelegt (siehe dort `db/00-shared-schema.sql`), damit
künftige Vereins-Apps dieselben Personen-/Mannschaftsdaten mitnutzen können,
ohne sie zu duplizieren. Diese App ist der erste tatsächliche Konsument
dieses Musters.

Mitgliederverwaltungs-spezifische Zusatzdaten zu einer Person (Mitgliedschaft,
Beitragsklasse, Ämter, Erziehungsberechtigte, Beitragsfälligkeiten) gehören
**nicht** in `players`, sondern in eigene Tabellen in `ssv_member_management`,
die per Fremdschlüssel auf `ssv_shared_members.players` verweisen — exakt das
Muster, das travel-expenses für `player_billing_settings` vorgemacht hat.

Legt diese App eine neue Person an (z.B. neues Vereinsmitglied ohne
Fahrtkosten-Bezug), landet sie direkt in `ssv_shared_members.players` und ist
damit automatisch auch für travel-expenses sichtbar.

## Kein eigener MariaDB-Container

Diese App betreibt bewusst **keinen eigenen `mariadb`-Service** — sie
verbindet sich mit dem MariaDB-Server von travel-expenses (dort läuft
`ssv_shared_members` bereits):

- **Lokale Entwicklung**: über den von travel-expenses nach außen
  exponierten Port (`DB_HOST=127.0.0.1`, `DB_PORT=3308`, siehe `.env.example`
  dort) — travel-expenses muss also lokal laufen
  (`docker-compose up mariadb` genügt).
- **Produktion**: über das externe Docker-Netzwerk `ssv-shared` per
  Docker-DNS (`ssv-travel-mariadb:3306`), analog zum in travel-expenses'
  CLAUDE.md beschriebenen Muster für künftige Apps.

Grund: Eine eigene Kopie von `ssv_shared_members` hätte zur Folge, dass
Mitgliederdaten zwischen den Apps auseinanderlaufen — genau das, was die
gemeinsame Datenbank verhindern soll.

## DB-User `ssv_members`

Diese App nutzt einen eigenen DB-User `ssv_members` (nicht den `ssv`-User
von travel-expenses) mit vollen Rechten auf `ssv_shared_members` **und**
`ssv_member_management`. Anlage einmalig manuell per
`scripts/grant-db-user.sql` gegen den laufenden MariaDB-Server (siehe
README).

## Schema-Migrationen

`db/00-schema.sql` besteht überwiegend aus `CREATE DATABASE IF NOT EXISTS` /
`CREATE TABLE IF NOT EXISTS` (keine INSERT/DROP) und wird bei **jedem**
Serverstart erneut ausgeführt (siehe `runSchemaMigrations()` in
`server.js`) — exakt das Muster aus travel-expenses. Eine neue Tabelle im
Code wird so automatisch auf einer laufenden Produktions-DB nachgezogen,
ohne manuellen SSH-Eingriff. Eine neue Spalte an einer bestehenden Tabelle
braucht normalerweise ein manuelles `ALTER TABLE` — **Ausnahme**: die
`ALTER TABLE ssv_shared_members.teams ADD COLUMN IF NOT EXISTS ...` /
`ADD FOREIGN KEY IF NOT EXISTS ...`-Zeilen in `00-schema.sql` sind bewusst
idempotent formuliert (MariaDB-spezifische `IF NOT EXISTS`-Syntax, gegen
MariaDB 10.11 verifiziert) und laufen deshalb ebenfalls bei jedem
Serverstart mit. Wichtig: `ADD CONSTRAINT IF NOT EXISTS ... FOREIGN KEY`
ist **kein** gültiges Syntax in MariaDB 10.11 — Fremdschlüssel müssen ohne
das `CONSTRAINT`-Keyword idempotent ergänzt werden
(`ADD FOREIGN KEY IF NOT EXISTS name (spalte) REFERENCES ...`).

## Abteilungen/Teams-Baumstruktur

SSV Rhade ist ein Mehrspartenverein (Outdoor, Indoor, Fußball, Tanzen,
Tischtennis) mit unterschiedlich tief verschachtelten Teams/Untergruppen je
Abteilung (z.B. Fußball → Jugend → F1, oder Indoor → Badminton →
Erwachsene). `ssv_shared_members.teams` ist deshalb um eine selbst-
referenzierende `parent_id`-Spalte erweitert (rein additiv, von dieser App
ergänzt — travel-expenses hat die Tabelle ursprünglich angelegt, kennt
`parent_id` aber nicht und funktioniert unverändert weiter).
`parent_id IS NULL` = Abteilung (oberste Ebene), sonst Team/Untergruppe
beliebiger Tiefe. Die 5 Abteilungen werden per `db/01-seed-data.sql`
angelegt, die tiefere Struktur wird über den "Abteilungen"-Tab im
Admin-Dashboard gepflegt.

Ein Mitglied kann gleichzeitig in mehreren Teams/Abteilungen sein (z.B.
Fußball UND Tischtennis) — dafür gibt es die neue, ebenfalls in
`ssv_shared_members` liegende Tabelle `player_teams` (n:m,
Fremdschlüssel auf `players`/`teams`, `ON DELETE CASCADE`).

**Best-effort-Sync mit travel-expenses:** travel-expenses kennt nur
`players.team_id` (eine einzelne Spalte), nicht `player_teams`. Damit neue
oder umgezogene Fußball-Mitglieder trotzdem in travel-expenses' Spielerliste
und Fahrtkostenabrechnung auftauchen, setzt `POST member`
(`syncFootballTeamId()` in `server.js`) `team_id` automatisch mit, **wenn
genau ein** zugeordnetes Team unterhalb der Abteilung "Fußball" liegt
(Name als Konstante `FOOTBALL_DEPARTMENT_NAME` — bei Umbenennung der
Abteilung dort anpassen). Bei keiner oder mehreren Fußball-Zuordnungen wird
bewusst **nicht geraten** — `team_id` bleibt unverändert stehen, wird also
insbesondere nie automatisch geleert. Das ist nur ein **einseitiger**
Sync: Team-Änderungen, die jemand direkt in travel-expenses' eigener
Oberfläche vornimmt, kommen nicht in `player_teams` an — dafür bräuchte es
eine Änderung im travel-expenses-Repo selbst, das ist bewusst nicht Teil
dieser Umsetzung.

Mit dieser Erweiterung schreibt member-management erstmals nicht nur
Zeilen in die gemeinsame Datenbank, sondern verändert dort auch das Schema
selbst (neue Spalte an `teams`, neue Tabelle `player_teams`) — die
bisherige Rollenteilung "travel-expenses legt an, andere Apps lesen/nutzen
nur" gilt also nicht mehr uneingeschränkt.

**Backfill:** `db/00-schema.sql` übernimmt beim Serverstart einmalig (per
`INSERT IGNORE`, also gefahrlos wiederholbar) alle bestehenden
`players.team_id`-Werte nach `player_teams` — ohne das hätten alle vor
dieser Erweiterung angelegten Mitglieder nach dem Deploy plötzlich ohne
Team-Zuordnung dagestanden, weil `team_id` bis dahin der einzige Ort war,
an dem diese Information stand.

**Integritätsregeln beim Bearbeiten des Baums** (serverseitig in der
`team`-Action durchgesetzt, nicht nur per DB-Constraint, da
`uniq_parent_name` zwei `NULL`-Elternwerte nicht als gleich behandelt):
Ein Knoten kann nicht unter sich selbst oder einen eigenen Nachfahren
verschoben werden (Zyklus-Schutz), und zwei Knoten auf derselben Ebene
dürfen nicht denselben Namen tragen. `team-delete` räumt zusätzlich
`players.team_id` für alle gelöschten Knoten (inkl. kaskadierter
Unterknoten) auf, da die FK darauf kein `ON DELETE CASCADE` hat.

## Beitragsverwaltung — Scope der ersten Version

`membership_fees` bildet Beitragsfälligkeiten und Zahlungsstatus ab, aber
**ohne** automatisierten Mahnwesen-Mailversand oder PDF-Export — das ist
bewusst zurückgestellt. Status wird manuell im Admin-Dashboard gepflegt.
