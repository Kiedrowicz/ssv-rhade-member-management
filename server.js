import dotenv from 'dotenv';
import express from 'express';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { createSelfServiceRouter } from './self-service.js';

// override: true, weil travel-expenses lokal dieselben Variablennamen
// (DB_USER, DB_PASSWORD, ...) bereits als Shell-/System-Umgebungsvariablen
// setzt - ohne override wuerden die eigenen Werte aus .env sonst ignoriert.
dotenv.config({ override: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// 15mb statt Default (100kb), damit Mitgliedsbild-Uploads (Base64-kodiert)
// nicht am Body-Limit scheitern - gleiches Muster wie travel-expenses'
// Unterschriften-Upload.
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'app')));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const AUTH_COOKIE = 'mm_session';
// App-uebergreifende Personen-/Mannschaftsdaten liegen in einer eigenen
// Datenbank auf demselben MariaDB-Server (angelegt von travel-expenses),
// siehe CLAUDE.md, Abschnitt "Gemeinsame Mitglieder-Datenbank".
const SHARED_DB = process.env.SHARED_DB_NAME || 'ssv_shared_members';

// Es gibt in dieser ersten Version nur die Rolle ADMIN (kein
// Mitglieder-Self-Service) - alles ausser Login/Logout braucht Auth.
const PUBLIC_ACTIONS = new Set(['login', 'logout']);

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || '127.0.0.1',
  port:               parseInt(process.env.DB_PORT || '3306'),
  database:           process.env.DB_NAME     || 'ssv_member_management',
  user:               process.env.DB_USER     || 'ssv_members',
  password:           process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit:    10,
  charset:            'utf8mb4',
  dateStrings:        true,
});

// ── Hilfsfunktionen ──────────────────────────────────────────────────────

function fail(res, msg, code = 400) {
  return res.status(code).json({ error: msg });
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return cookies;
}

function setAuthCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200${secure}`);
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function authenticate(req) {
  const token = parseCookies(req)[AUTH_COOKIE];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

async function writeAudit({ userAccountId, tableName, recordId, fieldName, oldValue, newValue }) {
  await pool.query(
    `INSERT INTO audit_log (user_account_id, table_name, record_id, field_name, old_value, new_value)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userAccountId ?? null, tableName, recordId, fieldName, oldValue ?? null, newValue ?? null]
  );
}

// Baut den Pfad ("Fussball > Jugend > F1") fuer einen Team-Knoten aus der
// kompletten (kleinen) Teams-Liste - kein rekursives SQL noetig, da die
// gesamte Baumstruktur ohnehin nur eine Handvoll Zeilen hat.
function teamPath(allTeams, teamId) {
  const byId = new Map(allTeams.map(t => [t.id, t]));
  const parts = [];
  let current = byId.get(teamId);
  while (current) {
    parts.unshift(current.name);
    current = current.parent_id ? byId.get(current.parent_id) : null;
  }
  return parts.join(' › ');
}

// Alle Nachfahren-IDs eines Knotens - vor dem Verschieben (parentId
// aendern) muss geprueft werden, dass der neue Elternknoten kein eigener
// Nachfahre ist, sonst entsteht ein Zyklus im Baum (siehe 'team'-Action).
function getDescendantIds(allTeams, id) {
  const byParent = new Map();
  for (const t of allTeams) {
    const key = t.parent_id || 0;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(t);
  }
  const result = new Set();
  (function walk(parentId) {
    for (const t of (byParent.get(parentId) || [])) {
      result.add(t.id);
      walk(t.id);
    }
  })(id);
  return result;
}

function requireFields(body, fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === '') return f;
  }
  return null;
}

// "Austritt vorgemerkt" ist bewusst kein eigener memberships.status-Wert,
// sondern aus Status + Austrittsdatum abgeleitet: noch nicht TERMINATED,
// aber left_at liegt in der Zukunft. Liegt left_at in der Vergangenheit
// (Admin hat den Status nicht nachgezogen), gilt die Person trotzdem
// schon als ausgetreten. Fuer die ANZEIGE (Status-Spalte/Badge) je Zeile.
const EFFECTIVE_STATUS_SQL = `
  CASE
    WHEN m.status = 'TERMINATED' THEN 'TERMINATED'
    WHEN m.left_at IS NOT NULL AND m.left_at <= CURDATE() THEN 'TERMINATED'
    WHEN m.left_at IS NOT NULL AND m.left_at > CURDATE() THEN 'PENDING'
    ELSE m.status
  END
`;

// Der Status-FILTER ist bewusst NICHT deckungsgleich mit obigem
// effective_status: "Austritt vorgemerkt" ist ein zusaetzlicher,
// UEBERLAPPENDER Filter, keine eigene ausschliessende Kategorie - wer
// noch aktiv ist, aber schon ein Austrittsdatum in der Zukunft hat, soll
// im normalen Tagesbetrieb trotzdem unter "Aktiv" auftauchen (nur mit
// Hinweis-Badge), sonst waere er im Alltag ploetzlich nicht mehr
// auffindbar. Nur "Ausgetreten" schliesst tatsaechlich aus dem
// Aktiv/Ruhend-Filter aus.
function statusFilterSql(status) {
  switch (status) {
    case 'ACTIVE': return `m.status = 'ACTIVE'`;
    case 'PAUSED': return `m.status = 'PAUSED'`;
    case 'PENDING': return `m.status <> 'TERMINATED' AND m.left_at IS NOT NULL AND m.left_at > CURDATE()`;
    case 'TERMINATED': return `(m.status = 'TERMINATED' OR (m.left_at IS NOT NULL AND m.left_at <= CURDATE()))`;
    default: return null;
  }
}

// Name der Fussball-Abteilung (oberste Ebene) - travel-expenses kennt nur
// players.team_id (eine einzelne Spalte), nicht player_teams. Damit neue
// oder umgezogene Fussball-Mitglieder trotzdem in travel-expenses sichtbar
// bleiben, wird team_id best-effort mitgesetzt, siehe syncFootballTeamId()
// unten und CLAUDE.md, Abschnitt "Abteilungen/Teams-Baumstruktur". Bei
// Umbenennung der Abteilung hier anpassen.
const FOOTBALL_DEPARTMENT_NAME = 'Fußball';

function isUnderFootballDepartment(allTeams, teamId) {
  const byId = new Map(allTeams.map(t => [t.id, t]));
  let current = byId.get(teamId);
  while (current) {
    if (!current.parent_id && current.name === FOOTBALL_DEPARTMENT_NAME) return true;
    current = current.parent_id ? byId.get(current.parent_id) : null;
  }
  return false;
}

// Best-effort-Sync fuer travel-expenses: wenn genau EIN zugeordnetes Team
// unter der Fussball-Abteilung liegt, players.team_id darauf setzen. Bei
// keiner oder mehreren Fussball-Zuordnungen bewusst nicht raten -
// team_id bleibt unveraendert (kein automatisches Leeren/Ueberschreiben
// bei Mehrdeutigkeit).
async function syncFootballTeamId(playerId, teamIdList) {
  const [allTeams] = await pool.query(`SELECT id, name, parent_id FROM ${SHARED_DB}.teams`);
  const footballTeamIds = teamIdList.filter(tid => isUnderFootballDepartment(allTeams, tid));
  if (footballTeamIds.length === 1) {
    await pool.query(`UPDATE ${SHARED_DB}.players SET team_id = ? WHERE id = ?`, [footballTeamIds[0], playerId]);
  }
}

// Kurzform eines verlinkten Mitglieds (Familie/Zahler/Betreuer) fuer die
// Detailseite - genug fuer einen anklickbaren Chip (Name + Mitgl.-Nr.),
// ohne den kompletten member-Datensatz nachzuladen.
async function fetchMemberSummary(playerId) {
  if (!playerId) return null;
  const [[row]] = await pool.query(
    `SELECT p.id, p.first_name, p.last_name, m.membership_number
     FROM ${SHARED_DB}.players p LEFT JOIN memberships m ON m.player_id = p.id
     WHERE p.id = ?`,
    [playerId]
  );
  return row || null;
}

// Rueckwaertssuche: alle Mitglieder, deren memberships.<column> auf
// playerId zeigt (z.B. "wer hat mich als Zahler hinterlegt"). column wird
// nie aus Nutzereingaben befuellt (nur intern aus fest kodierten
// Spaltennamen aufgerufen), daher unproblematisch trotz String-Interpolation.
async function fetchMembersByMembershipColumn(column, playerId) {
  const [rows] = await pool.query(
    `SELECT p.id, p.first_name, p.last_name, m.membership_number
     FROM memberships m JOIN ${SHARED_DB}.players p ON p.id = m.player_id
     WHERE m.${column} = ? ORDER BY p.last_name, p.first_name`,
    [playerId]
  );
  return rows;
}

// ── Admin-Bootstrap ──────────────────────────────────────────────────────

async function ensureAdminAccount() {
  const [[{ count }]] = await pool.query("SELECT COUNT(*) as count FROM user_accounts WHERE role = 'ADMIN'");
  if (count > 0) return;

  const password = crypto.randomBytes(9).toString('base64url');
  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO user_accounts (username, password_hash, role, active) VALUES ('admin', ?, 'ADMIN', 1)`,
    [passwordHash]
  );

  console.log('==============================================');
  console.log('Erstmaliger Admin-Zugang erzeugt:');
  console.log('  Benutzername: admin');
  console.log(`  Passwort:     ${password}`);
  console.log('Bitte ueber die Aktion "change-password" nach dem ersten Login aendern.');
  console.log('==============================================');
}

// isUnderFootballDepartment() matcht per exaktem Namensvergleich - wird die
// Abteilung ueber den "Abteilungen"-Tab umbenannt oder verschoben, bricht
// der travel-expenses-Sync (syncFootballTeamId) danach still ab, ohne dass
// das irgendwo auffaellt. Deshalb bei jedem Serverstart einmal pruefen und
// notfalls in die Konsole warnen - kein UI-Element dafuer, um den Umfang
// nicht auszuweiten (siehe CLAUDE.md).
async function warnIfFootballDepartmentMissing() {
  const [[row]] = await pool.query(
    `SELECT id FROM ${SHARED_DB}.teams WHERE parent_id IS NULL AND name = ?`,
    [FOOTBALL_DEPARTMENT_NAME]
  );
  if (!row) {
    console.warn(`WARNUNG: Keine oberste Abteilung namens "${FOOTBALL_DEPARTMENT_NAME}" gefunden - der travel-expenses-Sync (syncFootballTeamId) findet dadurch nie ein Fussball-Team und tut nichts. Wurde die Abteilung umbenannt? Siehe FOOTBALL_DEPARTMENT_NAME in server.js.`);
  }
}

// Selbstbedienung (Launchpad) + Einwilligungen - eigene, eng begrenzte
// Actions VOR den Admin-Routern; unbekannte Actions laufen per next() weiter.
app.use(createSelfServiceRouter({ pool, SHARED_DB, authenticate, fail, writeAudit }));

// ── API-Router: GET (Lesevorgaenge) ─────────────────────────────────────

app.get('/api', async (req, res) => {
  const { action } = req.query;
  if (!PUBLIC_ACTIONS.has(action)) {
    req.user = authenticate(req);
    if (!req.user) return fail(res, 'Nicht angemeldet', 401);
    // Tokens mit scope (z.B. Launchpad-Selbstbedienung) sind auf die Actions
    // in self-service.js beschraenkt - nie Admin-Zugriff hier.
    if (req.user.scope) return fail(res, 'Keine Berechtigung', 403);
  }

  try {
    switch (action) {

      case 'me': {
        const [[account]] = await pool.query('SELECT username FROM user_accounts WHERE id = ?', [req.user.userAccountId]);
        if (!account) return fail(res, 'Konto nicht gefunden', 401);
        return res.json({ userAccountId: req.user.userAccountId, username: account.username });
      }

      // Komplette flache Liste (inkl. inaktiver Knoten und parent_id) -
      // Frontend baut daraus den Baum. Kein serverseitiger active-Filter
      // mehr, da die Abteilungsverwaltung auch inaktive Knoten anzeigen
      // koennen muss.
      case 'teams': {
        const [rows] = await pool.query(`SELECT id, name, parent_id, active FROM ${SHARED_DB}.teams ORDER BY name`);
        return res.json(rows);
      }

      case 'membership-types': {
        const [rows] = await pool.query('SELECT * FROM membership_types ORDER BY name');
        return res.json(rows);
      }

      case 'categories': {
        const [rows] = await pool.query('SELECT * FROM categories ORDER BY name');
        return res.json(rows);
      }

      // Standard-Einstiegsseite: schlanke Liste mit kombinierbaren Filtern.
      // Ausgetretene sind per Default (kein status-Parameter) NICHT dabei,
      // siehe Frontend (filterStatus startet auf 'ACTIVE').
      case 'members': {
        const { search, status, teamId, city, gender, ageFrom, ageTo, joinedFrom, joinedTo, leftFrom, leftTo } = req.query;
        const where = [];
        const params = [];
        if (search) {
          where.push(`(p.first_name LIKE ? OR p.last_name LIKE ? OR m.membership_number LIKE ?
            OR p.email LIKE ? OR p.phone LIKE ? OR p.mobile_phone LIKE ? OR p.city LIKE ?)`);
          params.push(...Array(7).fill(`%${search}%`));
        }
        if (status) {
          const statusSql = statusFilterSql(status);
          if (statusSql) where.push(statusSql);
        }
        if (teamId) {
          const [allTeamsForFilter] = await pool.query(`SELECT id, parent_id FROM ${SHARED_DB}.teams`);
          const teamIdsIncludingDescendants = [Number(teamId), ...getDescendantIds(allTeamsForFilter, Number(teamId))];
          where.push(`EXISTS (SELECT 1 FROM ${SHARED_DB}.player_teams pt WHERE pt.player_id = p.id AND pt.team_id IN (${teamIdsIncludingDescendants.map(() => '?').join(',')}))`);
          params.push(...teamIdsIncludingDescendants);
        }
        if (city) { where.push('p.city LIKE ?'); params.push(`%${city}%`); }
        if (gender) { where.push('p.gender = ?'); params.push(gender); }
        // Altersgrenzen in Geburtsdatums-Grenzen umrechnen statt das Alter
        // je Zeile zu berechnen.
        if (ageFrom) { where.push('p.birth_date <= DATE_SUB(CURDATE(), INTERVAL ? YEAR)'); params.push(Number(ageFrom)); }
        if (ageTo) { where.push('p.birth_date > DATE_SUB(CURDATE(), INTERVAL ? YEAR)'); params.push(Number(ageTo) + 1); }
        if (joinedFrom) { where.push('m.joined_at >= ?'); params.push(joinedFrom); }
        if (joinedTo) { where.push('m.joined_at <= ?'); params.push(joinedTo); }
        if (leftFrom) { where.push('m.left_at >= ?'); params.push(leftFrom); }
        if (leftTo) { where.push('m.left_at <= ?'); params.push(leftTo); }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const [rows] = await pool.query(
          `SELECT p.id as player_id, p.first_name, p.last_name, p.email, p.phone, p.mobile_phone, p.city,
                  m.membership_number, m.left_at, (${EFFECTIVE_STATUS_SQL}) as effective_status
           FROM ${SHARED_DB}.players p
           LEFT JOIN memberships m ON m.player_id = p.id
           ${whereSql}
           ORDER BY p.last_name, p.first_name`,
          params
        );

        // Team-Zuordnung bewusst NICHT per GROUP_CONCAT(DISTINCT t.name)
        // in derselben Query - teams.name ist nur je Elternknoten eindeutig
        // (uniq_parent_name), zwei verschiedene Teams gleichen Namens in
        // unterschiedlichen Abteilungen (z.B. "Erwachsene" bei Badminton
        // UND Tischtennis) wuerden sonst durch DISTINCT-auf-Namen zu einem
        // einzigen Eintrag zusammenfallen. Stattdessen ueber die (kleine)
        // Teams-Liste den vollen Pfad je Team-ID bauen und als Array
        // zurueckgeben (Frontend rendert das als Tags/Pills).
        const [allTeams] = await pool.query(`SELECT id, name, parent_id FROM ${SHARED_DB}.teams`);
        const [playerTeamRows] = await pool.query(`SELECT player_id, team_id FROM ${SHARED_DB}.player_teams`);
        const teamsByPlayer = new Map();
        for (const pt of playerTeamRows) {
          if (!teamsByPlayer.has(pt.player_id)) teamsByPlayer.set(pt.player_id, []);
          teamsByPlayer.get(pt.player_id).push({ id: pt.team_id, path: teamPath(allTeams, pt.team_id) });
        }
        for (const row of rows) {
          row.teams = (teamsByPlayer.get(row.player_id) || []).sort((a, b) => a.path.localeCompare(b.path, 'de'));
        }
        return res.json(rows);
      }

      case 'member': {
        const playerId = Number(req.query.playerId);
        if (!playerId) return fail(res, 'playerId erforderlich');

        const [[player]] = await pool.query(
          `SELECT p.*,
                  m.membership_number, m.status, m.joined_at, m.left_at, m.notes,
                  m.family_head_player_id, m.payer_player_id, m.supervisor_player_id,
                  m.exit_reason, m.sync_outlook, m.do_not_dun,
                  mt.id as membership_type_id, mt.name as membership_type_name
           FROM ${SHARED_DB}.players p
           LEFT JOIN memberships m ON m.player_id = p.id
           LEFT JOIN membership_types mt ON mt.id = m.membership_type_id
           WHERE p.id = ?`,
          [playerId]
        );
        if (!player) return fail(res, 'Mitglied nicht gefunden', 404);

        const [offices] = await pool.query('SELECT * FROM member_offices WHERE player_id = ? ORDER BY valid_from DESC', [playerId]);
        const [guardians] = await pool.query('SELECT * FROM guardians WHERE player_id = ? ORDER BY last_name', [playerId]);
        const [fees] = await pool.query('SELECT * FROM membership_fees WHERE player_id = ? ORDER BY year DESC', [playerId]);
        const [teamRows] = await pool.query(
          `SELECT t.id, t.name FROM ${SHARED_DB}.player_teams pt JOIN ${SHARED_DB}.teams t ON t.id = pt.team_id WHERE pt.player_id = ?`,
          [playerId]
        );
        const [allTeams] = await pool.query(`SELECT id, name, parent_id FROM ${SHARED_DB}.teams`);
        const teams = teamRows.map(t => ({ id: t.id, name: t.name, path: teamPath(allTeams, t.id) }));

        const [[personalDetails]] = await pool.query('SELECT * FROM member_personal_details WHERE player_id = ?', [playerId]);
        const [[paymentDetails]] = await pool.query('SELECT * FROM member_payment_details WHERE player_id = ?', [playerId]);
        const [[mailingAddress]] = await pool.query('SELECT * FROM member_mailing_address WHERE player_id = ?', [playerId]);
        const [[photoRow]] = await pool.query('SELECT player_id FROM member_photos WHERE player_id = ?', [playerId]);
        const [honors] = await pool.query('SELECT * FROM member_honors WHERE player_id = ? ORDER BY honor_date DESC', [playerId]);
        const [services] = await pool.query('SELECT * FROM member_services WHERE player_id = ? ORDER BY service_date DESC', [playerId]);
        const [customFields] = await pool.query('SELECT * FROM member_custom_fields WHERE player_id = ? ORDER BY field_key', [playerId]);
        const [categories] = await pool.query(
          `SELECT c.id, c.name FROM member_categories mc JOIN categories c ON c.id = mc.category_id
           WHERE mc.player_id = ? ORDER BY c.name`,
          [playerId]
        );

        const [familyHead, payer, supervisor, familyMembers, payees] = await Promise.all([
          fetchMemberSummary(player.family_head_player_id),
          fetchMemberSummary(player.payer_player_id),
          fetchMemberSummary(player.supervisor_player_id),
          fetchMembersByMembershipColumn('family_head_player_id', playerId),
          fetchMembersByMembershipColumn('payer_player_id', playerId),
        ]);

        return res.json({
          ...player, offices, guardians, fees, teams,
          personalDetails: personalDetails || null,
          paymentDetails: paymentDetails || null,
          mailingAddress: mailingAddress || null,
          hasPhoto: !!photoRow,
          honors, services, customFields, categories,
          familyHead, payer, supervisor, familyMembers, payees,
        });
      }

      // Binaer-Response (kein JSON) - Bild direkt als <img src> einbindbar.
      case 'member-photo': {
        const playerId = Number(req.query.playerId);
        if (!playerId) return fail(res, 'playerId erforderlich');
        const [[photo]] = await pool.query('SELECT image_data, content_type FROM member_photos WHERE player_id = ?', [playerId]);
        if (!photo) return fail(res, 'Kein Bild hinterlegt', 404);
        res.set('Content-Type', photo.content_type);
        res.set('Cache-Control', 'private, max-age=300');
        return res.send(photo.image_data);
      }

      default:
        return fail(res, 'Unbekannte Aktion', 404);
    }
  } catch (err) {
    console.error(`GET /api?action=${action} fehlgeschlagen:`, err);
    return fail(res, 'Interner Fehler', 500);
  }
});

// ── API-Router: POST (Schreibvorgaenge) ─────────────────────────────────

app.post('/api', async (req, res) => {
  const { action } = req.body;
  if (!PUBLIC_ACTIONS.has(action)) {
    req.user = authenticate(req);
    if (!req.user) return fail(res, 'Nicht angemeldet', 401);
    // Tokens mit scope (z.B. Launchpad-Selbstbedienung) sind auf die Actions
    // in self-service.js beschraenkt - nie Admin-Zugriff hier.
    if (req.user.scope) return fail(res, 'Keine Berechtigung', 403);
  }

  try {
    switch (action) {

      case 'login': {
        const { username, password } = req.body;
        if (!username || !password) return fail(res, 'Benutzername und Passwort erforderlich');

        const [[account]] = await pool.query('SELECT * FROM user_accounts WHERE username = ? AND active = 1', [username]);
        if (!account || !(await bcrypt.compare(password, account.password_hash))) {
          return fail(res, 'Ungueltige Anmeldedaten', 401);
        }

        await pool.query('UPDATE user_accounts SET last_login_at = NOW() WHERE id = ?', [account.id]);
        const token = jwt.sign(
          { userAccountId: account.id, username: account.username },
          JWT_SECRET,
          { expiresIn: '12h' }
        );
        setAuthCookie(res, token);
        return res.json({ ok: true });
      }

      case 'logout':
        clearAuthCookie(res);
        return res.json({ ok: true });

      case 'change-password': {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) return fail(res, 'Aktuelles und neues Passwort erforderlich');
        if (newPassword.length < 8) return fail(res, 'Neues Passwort muss mindestens 8 Zeichen haben');

        const [[account]] = await pool.query('SELECT * FROM user_accounts WHERE id = ?', [req.user.userAccountId]);
        if (!account || !(await bcrypt.compare(currentPassword, account.password_hash))) {
          return fail(res, 'Aktuelles Passwort ist falsch', 401);
        }
        const newHash = await bcrypt.hash(newPassword, 12);
        await pool.query('UPDATE user_accounts SET password_hash = ? WHERE id = ?', [newHash, account.id]);
        return res.json({ ok: true });
      }

      case 'member': {
        const missing = requireFields(req.body, ['firstName', 'lastName']);
        if (missing) return fail(res, `Feld "${missing}" erforderlich`);

        const {
          playerId, salutation, firstName, lastName, street, houseNumber, postalCode, city,
          email, phone, mobilePhone, gender, birthDate, teamIds,
          membershipNumber, membershipTypeId, status, joinedAt, leftAt, notes,
          familyHeadPlayerId, payerPlayerId, supervisorPlayerId, exitReason, syncOutlook, doNotDun,
          personalDetails, paymentDetails, mailingAddress,
        } = req.body;

        let resolvedPlayerId = playerId ? Number(playerId) : null;

        // team_id (die alte Einzel-Spalte) wird hier bewusst NICHT mehr
        // gesetzt - travel-expenses liest/schreibt sie weiter fuer sich,
        // diese App verwaltet Team-Zugehoerigkeit ausschliesslich ueber
        // player_teams (Mehrfachmitgliedschaft), siehe CLAUDE.md.
        if (resolvedPlayerId) {
          await pool.query(
            `UPDATE ${SHARED_DB}.players SET salutation=?, first_name=?, last_name=?, street=?, house_number=?,
               postal_code=?, city=?, email=?, phone=?, mobile_phone=?, gender=?, birth_date=? WHERE id=?`,
            [salutation || null, firstName, lastName, street || null, houseNumber || null, postalCode || null,
             city || null, email || null, phone || null, mobilePhone || null, gender || null, birthDate || null, resolvedPlayerId]
          );
        } else {
          const [result] = await pool.query(
            `INSERT INTO ${SHARED_DB}.players
               (salutation, first_name, last_name, street, house_number, postal_code, city, email, phone, mobile_phone, gender, birth_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [salutation || null, firstName, lastName, street || null, houseNumber || null, postalCode || null,
             city || null, email || null, phone || null, mobilePhone || null, gender || null, birthDate || null]
          );
          resolvedPlayerId = result.insertId;
        }

        // player_teams komplett ersetzen (einfaches "replace"-Muster,
        // konsistent mit dem Rest dieses Endpunkts) - in einer Transaktion,
        // damit ein Fehler beim INSERT (z.B. ein zwischenzeitlich von einem
        // anderen Admin geloeschtes Team) nicht die vorherige Zuordnung
        // ersatzlos leert.
        const teamIdList = Array.isArray(teamIds) ? teamIds.map(Number).filter(Boolean) : [];
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          await conn.query(`DELETE FROM ${SHARED_DB}.player_teams WHERE player_id = ?`, [resolvedPlayerId]);
          if (teamIdList.length) {
            await conn.query(
              `INSERT INTO ${SHARED_DB}.player_teams (player_id, team_id) VALUES ${teamIdList.map(() => '(?, ?)').join(', ')}`,
              teamIdList.flatMap(tid => [resolvedPlayerId, tid])
            );
          }
          await conn.commit();
        } catch (err) {
          await conn.rollback();
          throw err;
        } finally {
          conn.release();
        }
        await syncFootballTeamId(resolvedPlayerId, teamIdList);

        const [[existingMembership]] = await pool.query('SELECT status FROM memberships WHERE player_id = ?', [resolvedPlayerId]);
        await pool.query(
          `INSERT INTO memberships (player_id, membership_number, membership_type_id, status, joined_at, left_at, notes,
             family_head_player_id, payer_player_id, supervisor_player_id, exit_reason, sync_outlook, do_not_dun)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE membership_number=VALUES(membership_number), membership_type_id=VALUES(membership_type_id),
             status=VALUES(status), joined_at=VALUES(joined_at), left_at=VALUES(left_at), notes=VALUES(notes),
             family_head_player_id=VALUES(family_head_player_id), payer_player_id=VALUES(payer_player_id),
             supervisor_player_id=VALUES(supervisor_player_id), exit_reason=VALUES(exit_reason),
             sync_outlook=VALUES(sync_outlook), do_not_dun=VALUES(do_not_dun)`,
          [resolvedPlayerId, membershipNumber || null, membershipTypeId || null, status || 'ACTIVE',
           joinedAt || null, leftAt || null, notes || null,
           familyHeadPlayerId || null, payerPlayerId || null, supervisorPlayerId || null,
           exitReason || null, syncOutlook ? 1 : 0, doNotDun ? 1 : 0]
        );

        if (existingMembership && existingMembership.status !== (status || 'ACTIVE')) {
          await writeAudit({
            userAccountId: req.user.userAccountId, tableName: 'memberships', recordId: resolvedPlayerId,
            fieldName: 'status', oldValue: existingMembership.status, newValue: status || 'ACTIVE',
          });
        }

        // Persoenliche Zusatzdaten / Zahlungsdaten - 1:1-Tabellen, immer
        // upserten wenn das Frontend das jeweilige Objekt mitschickt (auch
        // mit ausschliesslich leeren Feldern, das loescht dann effektiv den
        // Inhalt statt die Zeile stehen zu lassen).
        if (personalDetails && typeof personalDetails === 'object') {
          await pool.query(
            `INSERT INTO member_personal_details (player_id, title, name_suffix, marital_status, debtor_number, birth_place, fax, website, country)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE title=VALUES(title), name_suffix=VALUES(name_suffix), marital_status=VALUES(marital_status),
               debtor_number=VALUES(debtor_number), birth_place=VALUES(birth_place), fax=VALUES(fax), website=VALUES(website),
               country=VALUES(country)`,
            [resolvedPlayerId, personalDetails.title || null, personalDetails.nameSuffix || null,
             personalDetails.maritalStatus || null, personalDetails.debtorNumber || null,
             personalDetails.birthPlace || null, personalDetails.fax || null, personalDetails.website || null,
             personalDetails.country || null]
          );
        }

        if (paymentDetails && typeof paymentDetails === 'object') {
          await pool.query(
            `INSERT INTO member_payment_details (player_id, iban, bic, account_number, bank_code, bank_name, account_holder,
               mandate_reference, mandate_date, mandate_status, payment_method, payment_interval, payment_day, due_after_days,
               next_booking_note, legacy_fee_rate_label, legacy_fee_label_1, legacy_fee_label_2, legacy_fee_label_3, legacy_fee_label_4)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE iban=VALUES(iban), bic=VALUES(bic), account_number=VALUES(account_number),
               bank_code=VALUES(bank_code), bank_name=VALUES(bank_name), account_holder=VALUES(account_holder),
               mandate_reference=VALUES(mandate_reference), mandate_date=VALUES(mandate_date), mandate_status=VALUES(mandate_status),
               payment_method=VALUES(payment_method), payment_interval=VALUES(payment_interval), payment_day=VALUES(payment_day),
               due_after_days=VALUES(due_after_days), next_booking_note=VALUES(next_booking_note),
               legacy_fee_rate_label=VALUES(legacy_fee_rate_label), legacy_fee_label_1=VALUES(legacy_fee_label_1),
               legacy_fee_label_2=VALUES(legacy_fee_label_2), legacy_fee_label_3=VALUES(legacy_fee_label_3),
               legacy_fee_label_4=VALUES(legacy_fee_label_4)`,
            [resolvedPlayerId, paymentDetails.iban || null, paymentDetails.bic || null, paymentDetails.accountNumber || null,
             paymentDetails.bankCode || null, paymentDetails.bankName || null, paymentDetails.accountHolder || null,
             paymentDetails.mandateReference || null, paymentDetails.mandateDate || null, paymentDetails.mandateStatus || null,
             paymentDetails.paymentMethod || null, paymentDetails.paymentInterval || null, paymentDetails.paymentDay || null,
             paymentDetails.dueAfterDays || null, paymentDetails.nextBookingNote || null,
             paymentDetails.legacyFeeRateLabel || null, paymentDetails.legacyFeeLabel1 || null,
             paymentDetails.legacyFeeLabel2 || null, paymentDetails.legacyFeeLabel3 || null, paymentDetails.legacyFeeLabel4 || null]
          );
        }

        // Abweichende Postanschrift ist optional - ein explizit auf null
        // gesetztes mailingAddress (Checkbox "abweichende Anschrift"
        // deaktiviert) loescht die Zeile wieder, statt sie mit leeren
        // Feldern stehen zu lassen.
        if (mailingAddress === null) {
          await pool.query('DELETE FROM member_mailing_address WHERE player_id = ?', [resolvedPlayerId]);
        } else if (mailingAddress && typeof mailingAddress === 'object') {
          await pool.query(
            `INSERT INTO member_mailing_address (player_id, recipient, street, house_number, postal_code, city, country)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE recipient=VALUES(recipient), street=VALUES(street), house_number=VALUES(house_number),
               postal_code=VALUES(postal_code), city=VALUES(city), country=VALUES(country)`,
            [resolvedPlayerId, mailingAddress.recipient || null, mailingAddress.street || null,
             mailingAddress.houseNumber || null, mailingAddress.postalCode || null,
             mailingAddress.city || null, mailingAddress.country || null]
          );
        }

        return res.json({ ok: true, playerId: resolvedPlayerId });
      }

      case 'membership-type': {
        const { id, name, annualFee, billingInterval, active } = req.body;
        const missing = requireFields(req.body, ['name']);
        if (missing) return fail(res, `Feld "${missing}" erforderlich`);
        if (annualFee === undefined || annualFee === null || isNaN(Number(annualFee))) {
          return fail(res, 'Jahresbeitrag erforderlich');
        }

        if (id) {
          await pool.query(
            'UPDATE membership_types SET name=?, annual_fee=?, billing_interval=?, active=? WHERE id=?',
            [name, Number(annualFee), billingInterval || 'YEARLY', active === false ? 0 : 1, id]
          );
          return res.json({ ok: true, id: Number(id) });
        }
        const [result] = await pool.query(
          'INSERT INTO membership_types (name, annual_fee, billing_interval, active) VALUES (?, ?, ?, ?)',
          [name, Number(annualFee), billingInterval || 'YEARLY', active === false ? 0 : 1]
        );
        return res.json({ ok: true, id: result.insertId });
      }

      // Abteilung (parentId leer) oder Team/Untergruppe (parentId gesetzt)
      // anlegen/umbenennen/verschieben.
      case 'team': {
        const { id, name, parentId, active } = req.body;
        const missing = requireFields(req.body, ['name']);
        if (missing) return fail(res, `Feld "${missing}" erforderlich`);

        const resolvedParentId = parentId ? Number(parentId) : null;

        if (id && resolvedParentId) {
          if (resolvedParentId === Number(id)) {
            return fail(res, 'Ein Knoten kann nicht sein eigener Elternknoten sein');
          }
          const [allTeams] = await pool.query(`SELECT id, parent_id FROM ${SHARED_DB}.teams`);
          if (getDescendantIds(allTeams, Number(id)).has(resolvedParentId)) {
            return fail(res, 'Ein Knoten kann nicht unter einen eigenen Nachfahren verschoben werden');
          }
        }

        // teams.name ist nur je Elternknoten eindeutig (uniq_parent_name),
        // nicht global - MariaDB behandelt zwei NULL-Werte in einem Unique-
        // Index als verschieden, daher wuerde der DB-Constraint zwei
        // gleichnamige Abteilungen auf oberster Ebene NICHT verhindern.
        // Deshalb hier zusaetzlich applikationsseitig pruefen.
        const dupParams = [name, resolvedParentId];
        let dupSql = `SELECT id FROM ${SHARED_DB}.teams WHERE name = ? AND parent_id <=> ?`;
        if (id) { dupSql += ' AND id != ?'; dupParams.push(id); }
        const [[duplicate]] = await pool.query(dupSql, dupParams);
        if (duplicate) return fail(res, 'Auf dieser Ebene gibt es bereits einen Knoten mit diesem Namen');

        if (id) {
          await pool.query(
            `UPDATE ${SHARED_DB}.teams SET name=?, parent_id=?, active=? WHERE id=?`,
            [name, resolvedParentId, active === false ? 0 : 1, id]
          );
          return res.json({ ok: true, id: Number(id) });
        }
        const [result] = await pool.query(
          `INSERT INTO ${SHARED_DB}.teams (name, parent_id, active) VALUES (?, ?, ?)`,
          [name, resolvedParentId, active === false ? 0 : 1]
        );
        return res.json({ ok: true, id: result.insertId });
      }

      // Loescht rekursiv auch alle Unterknoten (ON DELETE CASCADE auf
      // teams.parent_id) - Frontend warnt davor. players.team_id (die
      // travel-expenses-Spalte, siehe syncFootballTeamId) wird dabei
      // explizit mitbereinigt, da die FK darauf KEIN ON DELETE CASCADE hat
      // und sonst auf eine geloeschte Zeile zeigen wuerde.
      case 'team-delete': {
        const { id } = req.body;
        if (!id) return fail(res, 'id erforderlich');
        const [allTeams] = await pool.query(`SELECT id, parent_id FROM ${SHARED_DB}.teams`);
        const idsToClear = [Number(id), ...getDescendantIds(allTeams, Number(id))];
        await pool.query(`DELETE FROM ${SHARED_DB}.teams WHERE id = ?`, [id]);
        await pool.query(
          `UPDATE ${SHARED_DB}.players SET team_id = NULL WHERE team_id IN (${idsToClear.map(() => '?').join(',')})`,
          idsToClear
        );
        return res.json({ ok: true });
      }

      case 'office': {
        const { id, playerId, title, validFrom, validUntil } = req.body;
        const missing = requireFields(req.body, ['playerId', 'title']);
        if (missing) return fail(res, `Feld "${missing}" erforderlich`);

        if (id) {
          await pool.query(
            'UPDATE member_offices SET title=?, valid_from=?, valid_until=? WHERE id=?',
            [title, validFrom || null, validUntil || null, id]
          );
          return res.json({ ok: true, id: Number(id) });
        }
        const [result] = await pool.query(
          'INSERT INTO member_offices (player_id, title, valid_from, valid_until) VALUES (?, ?, ?, ?)',
          [Number(playerId), title, validFrom || null, validUntil || null]
        );
        return res.json({ ok: true, id: result.insertId });
      }

      case 'office-delete': {
        const { id } = req.body;
        if (!id) return fail(res, 'id erforderlich');
        await pool.query('DELETE FROM member_offices WHERE id = ?', [id]);
        return res.json({ ok: true });
      }

      case 'guardian': {
        const { id, playerId, firstName, lastName, relationship, email, phone } = req.body;
        const missing = requireFields(req.body, ['playerId', 'firstName', 'lastName']);
        if (missing) return fail(res, `Feld "${missing}" erforderlich`);

        if (id) {
          await pool.query(
            'UPDATE guardians SET first_name=?, last_name=?, relationship=?, email=?, phone=? WHERE id=?',
            [firstName, lastName, relationship || null, email || null, phone || null, id]
          );
          return res.json({ ok: true, id: Number(id) });
        }
        const [result] = await pool.query(
          'INSERT INTO guardians (player_id, first_name, last_name, relationship, email, phone) VALUES (?, ?, ?, ?, ?, ?)',
          [Number(playerId), firstName, lastName, relationship || null, email || null, phone || null]
        );
        return res.json({ ok: true, id: result.insertId });
      }

      case 'guardian-delete': {
        const { id } = req.body;
        if (!id) return fail(res, 'id erforderlich');
        await pool.query('DELETE FROM guardians WHERE id = ?', [id]);
        return res.json({ ok: true });
      }

      case 'fee': {
        const { id, playerId, year, amountDue, dueDate, status, paidAt, paymentMethod } = req.body;
        // year nur beim Neuanlegen erforderlich - beim Update (z.B. "als
        // bezahlt markieren") ist die Zeile schon vorhanden und year
        // bleibt unveraendert.
        const missing = requireFields(req.body, id ? ['playerId', 'amountDue', 'dueDate'] : ['playerId', 'year', 'amountDue', 'dueDate']);
        if (missing) return fail(res, `Feld "${missing}" erforderlich`);

        let oldStatus = null;
        if (id) {
          const [[existing]] = await pool.query('SELECT status FROM membership_fees WHERE id = ?', [id]);
          oldStatus = existing?.status ?? null;
          await pool.query(
            'UPDATE membership_fees SET amount_due=?, due_date=?, status=?, paid_at=?, payment_method=? WHERE id=?',
            [Number(amountDue), dueDate, status || 'OPEN', paidAt || null, paymentMethod || null, id]
          );
        } else {
          const [result] = await pool.query(
            `INSERT INTO membership_fees (player_id, year, amount_due, due_date, status, paid_at, payment_method)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [Number(playerId), Number(year), Number(amountDue), dueDate, status || 'OPEN', paidAt || null, paymentMethod || null]
          );
          return res.json({ ok: true, id: result.insertId });
        }

        if (oldStatus && status && oldStatus !== status) {
          await writeAudit({
            userAccountId: req.user.userAccountId, tableName: 'membership_fees', recordId: Number(id),
            fieldName: 'status', oldValue: oldStatus, newValue: status,
          });
        }
        return res.json({ ok: true, id: Number(id) });
      }

      case 'fee-delete': {
        const { id } = req.body;
        if (!id) return fail(res, 'id erforderlich');
        await pool.query('DELETE FROM membership_fees WHERE id = ?', [id]);
        return res.json({ ok: true });
      }

      case 'honor': {
        const { id, playerId, title, honorDate, note } = req.body;
        const missing = requireFields(req.body, ['playerId', 'title']);
        if (missing) return fail(res, `Feld "${missing}" erforderlich`);

        if (id) {
          await pool.query('UPDATE member_honors SET title=?, honor_date=?, note=? WHERE id=?', [title, honorDate || null, note || null, id]);
          return res.json({ ok: true, id: Number(id) });
        }
        const [result] = await pool.query(
          'INSERT INTO member_honors (player_id, title, honor_date, note) VALUES (?, ?, ?, ?)',
          [Number(playerId), title, honorDate || null, note || null]
        );
        return res.json({ ok: true, id: result.insertId });
      }

      case 'honor-delete': {
        const { id } = req.body;
        if (!id) return fail(res, 'id erforderlich');
        await pool.query('DELETE FROM member_honors WHERE id = ?', [id]);
        return res.json({ ok: true });
      }

      case 'service': {
        const { id, playerId, label, note, serviceDate } = req.body;
        const missing = requireFields(req.body, ['playerId', 'label']);
        if (missing) return fail(res, `Feld "${missing}" erforderlich`);

        if (id) {
          await pool.query('UPDATE member_services SET label=?, note=?, service_date=? WHERE id=?', [label, note || null, serviceDate || null, id]);
          return res.json({ ok: true, id: Number(id) });
        }
        const [result] = await pool.query(
          'INSERT INTO member_services (player_id, label, note, service_date) VALUES (?, ?, ?, ?)',
          [Number(playerId), label, note || null, serviceDate || null]
        );
        return res.json({ ok: true, id: result.insertId });
      }

      case 'service-delete': {
        const { id } = req.body;
        if (!id) return fail(res, 'id erforderlich');
        await pool.query('DELETE FROM member_services WHERE id = ?', [id]);
        return res.json({ ok: true });
      }

      case 'custom-field': {
        const { id, playerId, fieldKey, fieldValue } = req.body;
        const missing = requireFields(req.body, ['playerId', 'fieldKey']);
        if (missing) return fail(res, `Feld "${missing}" erforderlich`);

        if (id) {
          await pool.query('UPDATE member_custom_fields SET field_key=?, field_value=? WHERE id=?', [fieldKey, fieldValue || null, id]);
          return res.json({ ok: true, id: Number(id) });
        }
        const [result] = await pool.query(
          'INSERT INTO member_custom_fields (player_id, field_key, field_value) VALUES (?, ?, ?)',
          [Number(playerId), fieldKey, fieldValue || null]
        );
        return res.json({ ok: true, id: result.insertId });
      }

      case 'custom-field-delete': {
        const { id } = req.body;
        if (!id) return fail(res, 'id erforderlich');
        await pool.query('DELETE FROM member_custom_fields WHERE id = ?', [id]);
        return res.json({ ok: true });
      }

      // Neue Kategorie (Tag) anlegen - einzige Rolle ist ADMIN, daher keine
      // zusaetzliche Berechtigungspruefung noetig.
      case 'category': {
        const { name } = req.body;
        const missing = requireFields(req.body, ['name']);
        if (missing) return fail(res, `Feld "${missing}" erforderlich`);
        const [result] = await pool.query('INSERT IGNORE INTO categories (name) VALUES (?)', [name]);
        if (result.insertId) return res.json({ ok: true, id: result.insertId });
        const [[existing]] = await pool.query('SELECT id FROM categories WHERE name = ?', [name]);
        return res.json({ ok: true, id: existing.id });
      }

      // Einzelne Kategorie-Zuweisung hinzufuegen/entfernen (kein Bulk-
      // Replace wie bei teamIds, da die Anforderung explizit "hinzufuegen"/
      // "entfernen" als Einzelaktionen vorsieht).
      case 'member-category': {
        const { playerId, categoryId } = req.body;
        const missing = requireFields(req.body, ['playerId', 'categoryId']);
        if (missing) return fail(res, `Feld "${missing}" erforderlich`);
        await pool.query('INSERT IGNORE INTO member_categories (player_id, category_id) VALUES (?, ?)', [Number(playerId), Number(categoryId)]);
        return res.json({ ok: true });
      }

      case 'member-category-delete': {
        const { playerId, categoryId } = req.body;
        const missing = requireFields(req.body, ['playerId', 'categoryId']);
        if (missing) return fail(res, `Feld "${missing}" erforderlich`);
        await pool.query('DELETE FROM member_categories WHERE player_id = ? AND category_id = ?', [Number(playerId), Number(categoryId)]);
        return res.json({ ok: true });
      }

      // Mitgliedsbild hochladen/ersetzen - Base64-Body, serverseitig auf
      // 500x500px verkleinert/komprimiert (siehe CLAUDE.md, Abschnitt
      // "Mitgliedsbild"), dann als BLOB gespeichert.
      case 'member-photo': {
        const { playerId, imageBase64 } = req.body;
        const missing = requireFields(req.body, ['playerId', 'imageBase64']);
        if (missing) return fail(res, `Feld "${missing}" erforderlich`);

        const inputBuffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        const outputBuffer = await sharp(inputBuffer)
          .resize(500, 500, { fit: 'cover' })
          .jpeg({ quality: 80 })
          .toBuffer();

        await pool.query(
          `INSERT INTO member_photos (player_id, image_data, content_type) VALUES (?, ?, 'image/jpeg')
           ON DUPLICATE KEY UPDATE image_data = VALUES(image_data), content_type = VALUES(content_type)`,
          [Number(playerId), outputBuffer]
        );
        return res.json({ ok: true });
      }

      case 'member-photo-delete': {
        const { playerId } = req.body;
        if (!playerId) return fail(res, 'playerId erforderlich');
        await pool.query('DELETE FROM member_photos WHERE player_id = ?', [Number(playerId)]);
        return res.json({ ok: true });
      }

      // Legt fuer alle Mitglieder mit Status ACTIVE und hinterlegter
      // Beitragsklasse eine offene Faelligkeit fuer das angegebene Jahr an,
      // sofern noch keine existiert (uniq_player_year verhindert Duplikate).
      case 'generate-fees': {
        const { year, dueDate } = req.body;
        if (!year || !dueDate) return fail(res, 'year und dueDate erforderlich');

        const [candidates] = await pool.query(
          `SELECT m.player_id, mt.annual_fee
           FROM memberships m
           JOIN membership_types mt ON mt.id = m.membership_type_id
           WHERE m.status = 'ACTIVE'`
        );

        let created = 0;
        for (const c of candidates) {
          const [result] = await pool.query(
            `INSERT IGNORE INTO membership_fees (player_id, year, amount_due, due_date, status)
             VALUES (?, ?, ?, ?, 'OPEN')`,
            [c.player_id, Number(year), c.annual_fee, dueDate]
          );
          if (result.affectedRows > 0) created++;
        }
        return res.json({ ok: true, created, checked: candidates.length });
      }

      default:
        return fail(res, 'Unbekannte Aktion', 404);
    }
  } catch (err) {
    console.error(`POST /api action=${action} fehlgeschlagen:`, err);
    return fail(res, 'Interner Fehler', 500);
  }
});

// ── Start ────────────────────────────────────────────────────────────────

// db/00-schema.sql enthaelt ausschliesslich "CREATE DATABASE IF NOT EXISTS" /
// "CREATE TABLE IF NOT EXISTS" (keine ALTER/INSERT/DROP) und ist damit
// beliebig oft wiederholbar - wird bei JEDEM Serverstart erneut ausgefuehrt,
// damit eine neue Tabelle, die im Code hinzukommt, auf einer bereits
// laufenden Produktions-DB automatisch nachgezogen wird, ohne dass jemand
// manuell per SSH ein CREATE TABLE nachtragen muss. Setzt voraus, dass die
// Datenbank ssv_member_management selbst schon existiert (siehe
// scripts/grant-db-user.sql) - CREATE DATABASE IF NOT EXISTS darin ist nur
// ein zusaetzliches Sicherheitsnetz.
async function runSchemaMigrations() {
  const schemaSql = fs.readFileSync(path.join(__dirname, 'db', '00-schema.sql'), 'utf8');
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST     || '127.0.0.1',
    port:     parseInt(process.env.DB_PORT || '3306'),
    user:     process.env.DB_USER     || 'ssv_members',
    password: process.env.DB_PASSWORD,
    charset:  'utf8mb4',
    multipleStatements: true,
  });
  try {
    await conn.query(schemaSql);
  } finally {
    await conn.end();
  }
}

async function start() {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      if (attempt === 10) throw err;
      console.log(`Warte auf Datenbank (Versuch ${attempt}/10)...`);
      await new Promise(resolveWait => setTimeout(resolveWait, 2000));
    }
  }
  await runSchemaMigrations();
  await ensureAdminAccount();
  await warnIfFootballDepartmentMissing();
  app.listen(PORT, () => console.log(`Mitgliederverwaltung laeuft auf Port ${PORT}`));
}

start().catch(err => {
  console.error('Start fehlgeschlagen:', err);
  process.exit(1);
});
