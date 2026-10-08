-- SSV Rhade Mitgliederverwaltung – eigenes Schema.
--
-- Besteht ueberwiegend aus "CREATE TABLE IF NOT EXISTS" (keine DROP) und
-- ist damit beliebig oft wiederholbar - wird bei jedem Serverstart erneut
-- ausgefuehrt (siehe runSchemaMigrations() in server.js), damit eine neue
-- Tabelle automatisch auf einer laufenden Produktions-DB nachgezogen wird.
-- Ausnahme: die idempotent formulierten "ALTER TABLE ... IF NOT EXISTS"-
-- Zeilen fuer ssv_shared_members.teams weiter unten (siehe dortiger
-- Kommentar) - alle anderen Spaltenaenderungen an bestehenden Tabellen
-- brauchen weiterhin ein manuelles, nicht wiederholtes ALTER TABLE.
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

-- Zusaetzliche Personenfelder fuer die schlanke Mitgliederliste (Telefon-
-- Prioritaetslogik Mobil vor Festnetz, optionaler Geschlecht-Filter) -
-- rein additiv, travel-expenses kennt diese Spalten nicht und liest/
-- schreibt weiterhin nur das bestehende "phone" (= Festnetz/Telefon 1).
ALTER TABLE ssv_shared_members.players
  ADD COLUMN IF NOT EXISTS gender ENUM('MALE','FEMALE','DIVERSE') DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS mobile_phone VARCHAR(30) DEFAULT NULL;

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
-- teams.name war urspruenglich global eindeutig (flache Liste). In der
-- Baumstruktur muss stattdessen nur der Name je Elternknoten eindeutig
-- sein, sonst koennte es z.B. nicht sowohl unter Badminton als auch unter
-- Tischtennis eine Untergruppe "Erwachsene" geben.
ALTER TABLE ssv_shared_members.teams DROP INDEX IF EXISTS uniq_name;
ALTER TABLE ssv_shared_members.teams
  ADD UNIQUE INDEX IF NOT EXISTS uniq_parent_name (parent_id, name);

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

-- Backfill: bestehende players.team_id-Werte (von travel-expenses vor
-- dieser Erweiterung gesetzt) als player_teams-Zeile uebernehmen, damit
-- bereits vorhandene Mitglieder nach dem Deploy nicht ploetzlich ohne
-- Team-Zuordnung dastehen (players.team_id war bislang der einzige Ort,
-- an dem diese Information stand). INSERT IGNORE + PRIMARY KEY
-- (player_id, team_id) macht das gefahrlos wiederholbar - laeuft bei
-- jedem Serverstart, tut aber nach dem ersten Mal nichts mehr.
INSERT IGNORE INTO ssv_shared_members.player_teams (player_id, team_id)
  SELECT id, team_id FROM ssv_shared_members.players WHERE team_id IS NOT NULL;

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

-- Erweiterung von memberships um Familie/Zahler/Betreuer-Verknuepfungen
-- (jeweils Verweis auf ein anderes Mitglied) sowie ein paar weitere aus
-- Sage uebernommene Einzelfelder - rein additiv, siehe CLAUDE.md Abschnitt
-- "Mitgliedsdetailseite (Sage-Uebernahme)". "ADD CONSTRAINT IF NOT EXISTS
-- ... FOREIGN KEY" ist in MariaDB 10.11 ungueltig, daher ohne CONSTRAINT-
-- Keyword (gleiches Muster wie bei teams.parent_id oben).
ALTER TABLE ssv_member_management.memberships
  ADD COLUMN IF NOT EXISTS family_head_player_id INT UNSIGNED DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS payer_player_id INT UNSIGNED DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS supervisor_player_id INT UNSIGNED DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS exit_reason VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS sync_outlook TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS do_not_dun TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE ssv_member_management.memberships
  ADD FOREIGN KEY IF NOT EXISTS fk_memberships_family_head (family_head_player_id)
    REFERENCES ssv_shared_members.players(id) ON DELETE SET NULL;
ALTER TABLE ssv_member_management.memberships
  ADD FOREIGN KEY IF NOT EXISTS fk_memberships_payer (payer_player_id)
    REFERENCES ssv_shared_members.players(id) ON DELETE SET NULL;
ALTER TABLE ssv_member_management.memberships
  ADD FOREIGN KEY IF NOT EXISTS fk_memberships_supervisor (supervisor_player_id)
    REFERENCES ssv_shared_members.players(id) ON DELETE SET NULL;

-- Weitere Sage-Stammdatenfelder, die nicht in players/memberships passen
-- (1:1 je Person). Bewusst eine eigene Tabelle statt weiterer Spalten an
-- memberships, da rein persoenliche (nicht mitgliedschaftsbezogene) Daten.
-- country lebt bewusst hier (nicht auf ssv_shared_members.players), obwohl
-- es inhaltlich zur Hauptadresse gehoert - travel-expenses kennt/braucht
-- kein Land, es ist reine Mitgliederverwaltungs-Zusatzinformation (siehe
-- CLAUDE.md-Trennungsregel).
CREATE TABLE IF NOT EXISTS ssv_member_management.member_personal_details (
  player_id      INT UNSIGNED PRIMARY KEY,
  title          VARCHAR(50) DEFAULT NULL,
  name_suffix    VARCHAR(50) DEFAULT NULL,
  marital_status VARCHAR(50) DEFAULT NULL,
  debtor_number  VARCHAR(50) DEFAULT NULL,
  birth_place    VARCHAR(150) DEFAULT NULL,
  fax            VARCHAR(30) DEFAULT NULL,
  website        VARCHAR(255) DEFAULT NULL,
  country        VARCHAR(100) DEFAULT NULL,
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_personal_details_player
    FOREIGN KEY (player_id) REFERENCES ssv_shared_members.players(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Zahlungsdaten (Bankverbindung, SEPA, Zahlart/-intervall/-termin) - 1:1 je
-- Person. legacy_fee_rate_label/legacy_fee_label_1..4 sind unveraendert aus
-- Sage uebernommene Freitextfelder ("Beitragssatz", "Bez.-Beitrag01-04"),
-- deren genaue fachliche Bedeutung noch nicht abschliessend geklaert ist -
-- bewusst nicht interpretiert oder umbenannt, nur mitgefuehrt (siehe
-- CLAUDE.md).
CREATE TABLE IF NOT EXISTS ssv_member_management.member_payment_details (
  player_id             INT UNSIGNED PRIMARY KEY,
  iban                  VARCHAR(34) DEFAULT NULL,
  bic                   VARCHAR(11) DEFAULT NULL,
  account_number        VARCHAR(30) DEFAULT NULL,
  bank_code             VARCHAR(30) DEFAULT NULL,
  bank_name             VARCHAR(150) DEFAULT NULL,
  account_holder        VARCHAR(150) DEFAULT NULL,
  mandate_reference     VARCHAR(100) DEFAULT NULL,
  mandate_date          DATE DEFAULT NULL,
  mandate_status        VARCHAR(50) DEFAULT NULL,
  payment_method        VARCHAR(50) DEFAULT NULL,
  payment_interval      VARCHAR(50) DEFAULT NULL,
  payment_day           TINYINT UNSIGNED DEFAULT NULL,
  due_after_days        SMALLINT UNSIGNED DEFAULT NULL,
  next_booking_note     VARCHAR(255) DEFAULT NULL,
  legacy_fee_rate_label VARCHAR(150) DEFAULT NULL,
  legacy_fee_label_1    VARCHAR(150) DEFAULT NULL,
  legacy_fee_label_2    VARCHAR(150) DEFAULT NULL,
  legacy_fee_label_3    VARCHAR(150) DEFAULT NULL,
  legacy_fee_label_4    VARCHAR(150) DEFAULT NULL,
  updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_payment_details_player
    FOREIGN KEY (player_id) REFERENCES ssv_shared_members.players(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Abweichende Postanschrift (1:1 je Person, optional - Zeile existiert nur,
-- wenn tatsaechlich eine abweichende Anschrift gepflegt wurde).
CREATE TABLE IF NOT EXISTS ssv_member_management.member_mailing_address (
  player_id    INT UNSIGNED PRIMARY KEY,
  recipient    VARCHAR(255) DEFAULT NULL,
  street       VARCHAR(150) DEFAULT NULL,
  house_number VARCHAR(20) DEFAULT NULL,
  postal_code  VARCHAR(10) DEFAULT NULL,
  city         VARCHAR(150) DEFAULT NULL,
  country      VARCHAR(100) DEFAULT NULL,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_mailing_address_player
    FOREIGN KEY (player_id) REFERENCES ssv_shared_members.players(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Mitgliedsbild (1:1 je Person, optional). Als Blob in der eigenen DB
-- gespeichert statt als Datei im Container-Dateisystem - kein eigenes
-- Docker-Volume noetig, laeuft im bestehenden naechtlichen Backup mit.
-- Bilder werden serverseitig vor dem Speichern per sharp auf 500x500px
-- komprimiert (siehe server.js), daher MEDIUMBLOB (bis 16MB) ausreichend
-- dimensioniert.
CREATE TABLE IF NOT EXISTS ssv_member_management.member_photos (
  player_id    INT UNSIGNED PRIMARY KEY,
  image_data   MEDIUMBLOB NOT NULL,
  content_type VARCHAR(100) NOT NULL,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_photos_player
    FOREIGN KEY (player_id) REFERENCES ssv_shared_members.players(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ehrungen (1:n je Person).
CREATE TABLE IF NOT EXISTS ssv_member_management.member_honors (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  player_id  INT UNSIGNED NOT NULL,
  title      VARCHAR(255) NOT NULL,
  honor_date DATE DEFAULT NULL,
  note       VARCHAR(500) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_player (player_id),
  CONSTRAINT fk_honors_player
    FOREIGN KEY (player_id) REFERENCES ssv_shared_members.players(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Leistungen (1:n je Person) - generische Liste, da die genauen aus Sage
-- bekannten Unterfelder noch nicht bekannt sind (siehe CLAUDE.md).
CREATE TABLE IF NOT EXISTS ssv_member_management.member_services (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  player_id    INT UNSIGNED NOT NULL,
  label        VARCHAR(255) NOT NULL,
  note         VARCHAR(500) DEFAULT NULL,
  service_date DATE DEFAULT NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_player (player_id),
  CONSTRAINT fk_services_player
    FOREIGN KEY (player_id) REFERENCES ssv_shared_members.players(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Eigene Felder (1:n je Person) - echte Key-Value-Struktur, absichtlich
-- nicht im Frontend hartkodiert, da vereinsseitig frei erweiterbar.
CREATE TABLE IF NOT EXISTS ssv_member_management.member_custom_fields (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  player_id   INT UNSIGNED NOT NULL,
  field_key   VARCHAR(150) NOT NULL,
  field_value VARCHAR(1000) DEFAULT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_player (player_id),
  CONSTRAINT fk_custom_fields_player
    FOREIGN KEY (player_id) REFERENCES ssv_shared_members.players(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Kategorien (flache Tags, bewusst nicht Teil der Abteilungs-Baumstruktur -
-- Sage-Kategorien sind historisch flach, z.B. "Alte Herren" und "Fussball"
-- sind dort unabhaengige, gleichrangige Tags statt Eltern/Kind).
CREATE TABLE IF NOT EXISTS ssv_member_management.categories (
  id   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  UNIQUE KEY uniq_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ssv_member_management.member_categories (
  player_id   INT UNSIGNED NOT NULL,
  category_id INT UNSIGNED NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id, category_id),
  CONSTRAINT fk_member_categories_player
    FOREIGN KEY (player_id) REFERENCES ssv_shared_members.players(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_member_categories_category
    FOREIGN KEY (category_id) REFERENCES ssv_member_management.categories(id)
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

-- ── Selbstbedienung (Launchpad) und Einwilligungen (2026-10-08) ──────────
-- Rein additiv, die Admin-Oberflaeche dieser App funktioniert unveraendert.
-- Siehe self-service.js und CLAUDE.md, Abschnitt "Selbstbedienung".

-- Online-Kuendigung: wann/wie eingereicht (left_at = Austrittstermin)
ALTER TABLE ssv_member_management.memberships
  ADD COLUMN IF NOT EXISTS termination_requested_at DATETIME DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS termination_source VARCHAR(20) DEFAULT NULL;

-- Zeitpunkt, zu dem das Mitglied bei einer neuen IBAN den SEPA-Mandatstext
-- online bestaetigt hat (Mandatsreferenz bleibt Sache der Verwaltung)
ALTER TABLE ssv_member_management.member_payment_details
  ADD COLUMN IF NOT EXISTS mandate_confirmed_online_at DATETIME DEFAULT NULL;

-- Einwilligungen aus dem Aufnahmeantrag (freiwillig, jederzeit widerrufbar):
--   CONTACT_SHARING = Kontaktdaten an Verband/andere Mitglieder
--   MEDIA           = Fotos/Videos veroeffentlichen
-- Jede Aenderung ist eine neue Zeile (Historie), gueltig ist die juengste.
-- guardian_consent = bei Minderjaehrigen haben die gesetzlichen Vertreter
-- mit unterschrieben (Papier, erfasst durch die Verwaltung).
CREATE TABLE IF NOT EXISTS ssv_member_management.member_consents (
  id                              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  player_id                       INT UNSIGNED NOT NULL,
  consent_type                    ENUM('CONTACT_SHARING','MEDIA') NOT NULL,
  granted                         TINYINT(1) NOT NULL,
  guardian_consent                TINYINT(1) NOT NULL DEFAULT 0,
  source                          ENUM('PAPER','ONLINE','ADMIN') NOT NULL,
  note                            VARCHAR(500) DEFAULT NULL,
  recorded_by_user_account_id     INT UNSIGNED DEFAULT NULL,
  recorded_by_launchpad_account_id INT UNSIGNED DEFAULT NULL,
  created_at                      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_consents_player_type (player_id, consent_type),
  CONSTRAINT fk_consents_player
    FOREIGN KEY (player_id) REFERENCES ssv_shared_members.players(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_consents_user
    FOREIGN KEY (recorded_by_user_account_id) REFERENCES ssv_member_management.user_accounts(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
