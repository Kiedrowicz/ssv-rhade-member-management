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

`db/00-schema.sql` besteht ausschließlich aus `CREATE DATABASE IF NOT
EXISTS` / `CREATE TABLE IF NOT EXISTS` (keine ALTER/INSERT/DROP) und wird bei
**jedem** Serverstart erneut ausgeführt (siehe `runSchemaMigrations()` in
`server.js`) — exakt das Muster aus travel-expenses. Eine neue Tabelle im
Code wird so automatisch auf einer laufenden Produktions-DB nachgezogen,
ohne manuellen SSH-Eingriff. Eine neue Spalte an einer bestehenden Tabelle
braucht weiterhin ein manuelles `ALTER TABLE`.

## Beitragsverwaltung — Scope der ersten Version

`membership_fees` bildet Beitragsfälligkeiten und Zahlungsstatus ab, aber
**ohne** automatisierten Mahnwesen-Mailversand oder PDF-Export — das ist
bewusst zurückgestellt. Status wird manuell im Admin-Dashboard gepflegt.
