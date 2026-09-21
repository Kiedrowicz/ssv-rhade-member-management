-- Start-Beitragsklassen fuer die Erstinstallation - von Hand gepflegt,
-- analog db/02-seed-data.sql in travel-expenses. Wird NICHT automatisch bei
-- jedem Serverstart ausgefuehrt (anders als 00-schema.sql), sondern einmalig
-- manuell eingespielt, siehe README.

INSERT IGNORE INTO ssv_member_management.membership_types (name, annual_fee, billing_interval) VALUES
  ('Erwachsene', 120.00, 'YEARLY'),
  ('Jugend', 60.00, 'YEARLY'),
  ('Familie', 220.00, 'YEARLY'),
  ('Ehrenmitglied', 0.00, 'YEARLY');
