-- Start-Beitragsklassen fuer die Erstinstallation - von Hand gepflegt,
-- analog db/02-seed-data.sql in travel-expenses. Wird NICHT automatisch bei
-- jedem Serverstart ausgefuehrt (anders als 00-schema.sql), sondern einmalig
-- manuell eingespielt, siehe README.

INSERT IGNORE INTO ssv_member_management.membership_types (name, annual_fee, billing_interval) VALUES
  ('Erwachsene', 120.00, 'YEARLY'),
  ('Jugend', 60.00, 'YEARLY'),
  ('Familie', 220.00, 'YEARLY'),
  ('Ehrenmitglied', 0.00, 'YEARLY');

-- Die 5 Abteilungen des Vereins als oberste Ebene der Team-Baumstruktur
-- (siehe CLAUDE.md). Der VOLLSTAENDIGE Baum (Untergruppen wie "1. Damen"
-- unter Fussball, "Badminton" unter Indoor) wird inzwischen in
-- travel-expenses/db/02-seed-data.sql geseedt, nicht hier - das ist die
-- einzige der vier Apps mit eigenem MariaDB-Container (siehe deren
-- Kommentar dort) und laeuft deshalb automatisch bei einer frischen
-- Installation, waehrend diese Datei hier nur manuell eingespielt wird.
-- Diese 5 Zeilen bleiben trotzdem stehen (INSERT IGNORE macht sie
-- unschaedlich, falls travel-expenses' Seed schon gelaufen ist) - fuer den
-- Fall, dass member-management einmal eigenstaendig ohne travel-expenses
-- aufgesetzt wird.
INSERT IGNORE INTO ssv_shared_members.teams (name, parent_id) VALUES
  ('Outdoor', NULL),
  ('Indoor', NULL),
  ('Fußball', NULL),
  ('Tanzen', NULL),
  ('Tischtennis', NULL);

-- Kategorien (flache Tags) aus der alten Sage-Anwendung - nur die vom
-- Nutzer tatsaechlich genannten Namen, keine weiteren erfunden. Kann ueber
-- die Admin-Oberflaeche jederzeit um echte weitere Kategorien ergaenzt
-- werden, sobald diese bekannt sind.
INSERT IGNORE INTO ssv_member_management.categories (name) VALUES
  ('Alte Herren'),
  ('Ausgetretene Mitglieder'),
  ('Badminton'),
  ('Fahrradabteilung'),
  ('Formationstanz'),
  ('Frauenfitness'),
  ('Fußball'),
  ('Fußball Hobby'),
  ('Fußballabteilung gesamt'),
  ('Hobbytanz Erwachsene'),
  ('Hobbytanz Kinder'),
  ('Jungen');
