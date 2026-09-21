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
-- (siehe CLAUDE.md). Teams/Untergruppen darunter (z.B. "1. Damen" unter
-- Fussball, "Badminton" unter Indoor) werden bewusst nicht vorab geseedet -
-- die Struktur ist pro Abteilung unterschiedlich tief und wird ueber die
-- Admin-Oberflaeche gepflegt.
INSERT IGNORE INTO ssv_shared_members.teams (name, parent_id) VALUES
  ('Outdoor', NULL),
  ('Indoor', NULL),
  ('Fußball', NULL),
  ('Tanzen', NULL),
  ('Tischtennis', NULL);
