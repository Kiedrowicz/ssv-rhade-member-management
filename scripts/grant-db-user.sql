-- Einmalig manuell gegen den bestehenden MariaDB-Server ausfuehren (den
-- MariaDB-Container von travel-expenses), bevor diese App zum ersten Mal
-- gestartet wird. Kein automatisches Init-Skript moeglich, da der Container
-- bereits existiert und docker-entrypoint-initdb.d nur beim allerersten
-- Start eines frischen Volumes laeuft.
--
-- Lokal (travel-expenses' MariaDB laeuft bereits, Port 3308 nach aussen):
--   mysql -h 127.0.0.1 -P 3308 -u root -p < scripts/grant-db-user.sql
-- (Root-Passwort siehe travel-expenses' docker-compose.yml,
-- MARIADB_ROOT_PASSWORD)
--
-- Auf dem VPS: analog, aber gegen den dortigen Container/Port.
--
-- ssv_shared_members existiert bereits (angelegt von travel-expenses).
-- ssv_member_management wird hier zusaetzlich angelegt, falls noch nicht
-- vorhanden - server.js legt beim ersten Start ohnehin nur Tabellen an
-- (CREATE TABLE IF NOT EXISTS), nicht die Datenbank selbst.

CREATE DATABASE IF NOT EXISTS ssv_member_management
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'ssv_members'@'%' IDENTIFIED BY 'CHANGE-ME-vor-dem-Ausfuehren';

GRANT ALL PRIVILEGES ON ssv_member_management.* TO 'ssv_members'@'%';
GRANT ALL PRIVILEGES ON ssv_shared_members.* TO 'ssv_members'@'%';

FLUSH PRIVILEGES;
