-- SSV Rhade Mitgliederverwaltung – eigenes Schema.
--
-- Enthaelt ausschliesslich "CREATE TABLE IF NOT EXISTS" (keine ALTER/INSERT/
-- DROP) und ist damit beliebig oft wiederholbar - wird bei jedem Serverstart
-- erneut ausgefuehrt (siehe runSchemaMigrations() in server.js), damit eine
-- neue Tabelle automatisch auf einer laufenden Produktions-DB nachgezogen
-- wird. Eine neue Spalte an einer bestehenden Tabelle braucht weiterhin ein
-- manuelles ALTER TABLE.
--
-- Referenziert ssv_shared_members.players/.teams per datenbankuebergreifendem
-- Fremdschluessel (MariaDB erlaubt das innerhalb desselben Servers) - siehe
-- CLAUDE.md, Abschnitt "Gemeinsame Mitglieder-Datenbank". Die Datenbank
-- ssv_shared_members selbst wird NICHT hier angelegt (das macht
-- travel-expenses), muss beim ersten Start dieser App also bereits
-- existieren. Diese Datei erweitert ssv_shared_members aber zusaetzlich um
-- die Team-Baumstruktur (ALTER TABLE teams) und player_teams - siehe
-- CLAUDE.md, Abschnitt "Abteilungen/Teams-Baumstruktur".

CREATE DATABASE IF NOT EXISTS ssv_member_management
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Abteilungen/Teams als rekursive Baumstruktur (beliebige Tiefe, z.B.
-- Fussball -> Jugend -> F1, oder Indoor -> Badminton -> Erwachsene). Rein
-- additive Erweiterung von ssv_shared_members.teams (angelegt von
-- travel-expenses) - bestehende Zeilen/Spalten bleiben unveraendert,
-- travel-expenses' Queries funktionieren unveraendert weiter, siehe
-- CLAUDE.md, Abschnitt "Abteilungen/Teams-Baumstruktur". parent_id IS NULL
-- = Abteilung (oberste Ebene), sonst Team/Untergruppe. "ADD CONSTRAINT IF
-- NOT EXISTS ... FOREIGN KEY" ist in MariaDB 10.11 kein gueltiges Syntax
-- fuer Fremdschluessel (nur ohne CONSTRAINT-Keyword) - gegen die laufende
-- Dev-DB verifiziert (inkl. Wiederholbarkeit).
ALTER TABLE ssv_shared_members.teams
  ADD COLUMN IF NOT EXISTS parent_id INT UNSIGNED DEFAULT NULL,
  ADD INDEX IF NOT EXISTS idx_parent (parent_id);
ALTER TABLE ssv_shared_members.teams
  ADD FOREIGN KEY IF NOT EXISTS fk_teams_parent (parent_id)
    REFERENCES ssv_shared_members.teams(id) ON DELETE CASCADE;

-- Team-/Abteilungs-Mitgliedschaft (n:m - eine Person kann gleichzeitig in
-- mehreren Teams/Abteilungen sein, z.B. Fussball UND Tischtennis). Liegt
-- bewusst in ssv_shared_members (nicht hier), analog zu players/teams
-- selbst - siehe CLAUDE.md. players.team_id (die alte Einzel-Spalte, von
-- travel-expenses genutzt) bleibt davon unberuehrt und wird von dieser App
-- nicht mehr gepflegt.
CREATE TABLE IF NOT EXISTS ssv_shared_members.player_teams (
  player_id  INT UNSIGNED NOT NULL,
  team_id    INT UNSIGNED NOT NULL,
  joined_at  DATE DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id, team_id),
  INDEX idx_team (team_id),
  CONSTRAINT fk_player_teams_player
    FOREIGN KEY (player_id) REFERENCES ssv_shared_members.players(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_player_teams_team
    FOREIGN KEY (team_id) REFERENCES ssv_shared_members.teams(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Beitragsklassen (z.B. Erwachsene, Jugend, Familie, Ehrenmitglied).
CREATE TABLE IF NOT EXISTS ssv_member_management.membership_types (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name                VARCHAR(100) NOT NULL,
  annual_fee          DECIMAL(8,2) NOT NULL,
  billing_interval    ENUM('YEARLY','HALF_YEARLY','QUARTERLY','MONTHLY') NOT NULL DEFAULT 'YEARLY',
  active              TINYINT(1) NOT NULL DEFAULT 1,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Mitgliedschaft einer Person (1:1 zu ssv_shared_members.players). Personen
-- ohne Zeile hier sind (noch) kein Vereinsmitglied, z.B. weil sie nur als
-- Spielerin in travel-expenses angelegt wurden.
CREATE TABLE IF NOT EXISTS ssv_member_management.memberships (
  player_id           INT UNSIGNED PRIMARY KEY,
  membership_number    VARCHAR(30) DEFAULT NULL,
  membership_type_id  INT UNSIGNED DEFAULT NULL,
  status               ENUM('ACTIVE','PAUSED','TERMINATED') NOT NULL DEFAULT 'ACTIVE',
  joined_at            DATE DEFAULT NULL,
  left_at              DATE DEFAULT NULL,
  notes                VARCHAR(1000) DEFAULT NULL,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_membership_number (membership_number),
  INDEX idx_status (status),
  INDEX idx_membership_type (membership_type_id),
  CONSTRAINT fk_memberships_player
    FOREIGN KEY (player_id) REFERENCES ssv_shared_members.players(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_memberships_type
    FOREIGN KEY (membership_type_id) REFERENCES ssv_member_management.membership_types(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Aemter/Funktionen (Trainer, Vorstand, Uebungsleiter). Eine Person kann
-- mehrere Aemter gleichzeitig oder nacheinander innehaben, daher eigene
-- Tabelle statt einer Spalte an memberships.
CREATE TABLE IF NOT EXISTS ssv_member_management.member_offices (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  player_id     INT UNSIGNED NOT NULL,
  title         VARCHAR(150) NOT NULL,
  valid_from    DATE DEFAULT NULL,
  valid_until   DATE DEFAULT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_player (player_id),
  CONSTRAINT fk_offices_player
    FOREIGN KEY (player_id) REFERENCES ssv_shared_members.players(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Erziehungsberechtigte fuer minderjaehrige Mitglieder. Ein Kind kann mehr
-- als eine erziehungsberechtigte Person haben, daher eigene Tabelle statt
-- fester Spalten an players/memberships.
CREATE TABLE IF NOT EXISTS ssv_member_management.guardians (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  player_id     INT UNSIGNED NOT NULL,
  first_name    VARCHAR(100) NOT NULL,
  last_name     VARCHAR(100) NOT NULL,
  relationship  VARCHAR(100) DEFAULT NULL,
  email         VARCHAR(255) DEFAULT NULL,
  phone         VARCHAR(30)  DEFAULT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_player (player_id),
  CONSTRAINT fk_guardians_player
    FOREIGN KEY (player_id) REFERENCES ssv_shared_members.players(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Beitragsfaelligkeiten je Mitglied und Jahr. Kein automatisierter
-- Mahnwesen-Mailversand in dieser ersten Version (siehe CLAUDE.md) - Status
-- wird manuell im Admin-Dashboard gepflegt.
CREATE TABLE IF NOT EXISTS ssv_member_management.membership_fees (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  player_id       INT UNSIGNED NOT NULL,
  year            SMALLINT UNSIGNED NOT NULL,
  amount_due      DECIMAL(8,2) NOT NULL,
  due_date        DATE NOT NULL,
  status          ENUM('OPEN','PAID','OVERDUE') NOT NULL DEFAULT 'OPEN',
  paid_at         DATE DEFAULT NULL,
  payment_method  VARCHAR(50) DEFAULT NULL,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_player_year (player_id, year),
  INDEX idx_status (status),
  CONSTRAINT fk_fees_player
    FOREIGN KEY (player_id) REFERENCES ssv_shared_members.players(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Admin-Login. Analog travel-expenses' user_accounts, aber ohne player_id-
-- Verknuepfung fuer Mitglieder-Self-Service - das ist bewusst nicht Teil
-- dieser ersten Version (siehe CLAUDE.md).
CREATE TABLE IF NOT EXISTS ssv_member_management.user_accounts (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(150) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('ADMIN') NOT NULL DEFAULT 'ADMIN',
  active        TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME DEFAULT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Nachvollziehbarkeit von Statusaenderungen (Mitgliedschaft, Beitraege),
-- analog travel-expenses' audit_log.
CREATE TABLE IF NOT EXISTS ssv_member_management.audit_log (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_account_id INT UNSIGNED DEFAULT NULL,
  table_name      VARCHAR(100) NOT NULL,
  record_id       INT UNSIGNED NOT NULL,
  field_name      VARCHAR(100) NOT NULL,
  old_value       VARCHAR(500) DEFAULT NULL,
  new_value       VARCHAR(500) DEFAULT NULL,
  changed_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_table_record (table_name, record_id),
  CONSTRAINT fk_audit_user
    FOREIGN KEY (user_account_id) REFERENCES ssv_member_management.user_accounts(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
