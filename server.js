import dotenv from 'dotenv';
import express from 'express';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

// override: true, weil travel-expenses lokal dieselben Variablennamen
// (DB_USER, DB_PASSWORD, ...) bereits als Shell-/System-Umgebungsvariablen
// setzt - ohne override wuerden die eigenen Werte aus .env sonst ignoriert.
dotenv.config({ override: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
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
  password:           process.env.DB_PASSWORD || 'change-me',
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

function requireFields(body, fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === '') return f;
  }
  return null;
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

// ── API-Router: GET (Lesevorgaenge) ─────────────────────────────────────

app.get('/api', async (req, res) => {
  const { action } = req.query;
  if (!PUBLIC_ACTIONS.has(action)) {
    req.user = authenticate(req);
    if (!req.user) return fail(res, 'Nicht angemeldet', 401);
  }

  try {
    switch (action) {

      case 'me': {
        const [[account]] = await pool.query('SELECT username FROM user_accounts WHERE id = ?', [req.user.userAccountId]);
        if (!account) return fail(res, 'Konto nicht gefunden', 401);
        return res.json({ userAccountId: req.user.userAccountId, username: account.username });
      }

      case 'teams': {
        const [rows] = await pool.query(`SELECT id, name FROM ${SHARED_DB}.teams WHERE active = 1 ORDER BY name`);
        return res.json(rows);
      }

      case 'membership-types': {
        const [rows] = await pool.query('SELECT * FROM membership_types ORDER BY name');
        return res.json(rows);
      }

      case 'members': {
        const { search, status, teamId } = req.query;
        const where = [];
        const params = [];
        if (search) {
          where.push('(p.first_name LIKE ? OR p.last_name LIKE ? OR m.membership_number LIKE ?)');
          params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }
        if (status) { where.push('m.status = ?'); params.push(status); }
        if (teamId) { where.push('p.team_id = ?'); params.push(Number(teamId)); }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const [rows] = await pool.query(
          `SELECT p.id as player_id, p.salutation, p.first_name, p.last_name, p.email, p.phone,
                  p.birth_date, t.id as team_id, t.name as team_name,
                  m.membership_number, m.status, m.joined_at, m.left_at,
                  mt.id as membership_type_id, mt.name as membership_type_name
           FROM ${SHARED_DB}.players p
           LEFT JOIN ${SHARED_DB}.teams t ON t.id = p.team_id
           LEFT JOIN memberships m ON m.player_id = p.id
           LEFT JOIN membership_types mt ON mt.id = m.membership_type_id
           ${whereSql}
           ORDER BY p.last_name, p.first_name`,
          params
        );
        return res.json(rows);
      }

      case 'member': {
        const playerId = Number(req.query.playerId);
        if (!playerId) return fail(res, 'playerId erforderlich');

        const [[player]] = await pool.query(
          `SELECT p.*, t.name as team_name,
                  m.membership_number, m.status, m.joined_at, m.left_at, m.notes,
                  mt.id as membership_type_id, mt.name as membership_type_name
           FROM ${SHARED_DB}.players p
           LEFT JOIN ${SHARED_DB}.teams t ON t.id = p.team_id
           LEFT JOIN memberships m ON m.player_id = p.id
           LEFT JOIN membership_types mt ON mt.id = m.membership_type_id
           WHERE p.id = ?`,
          [playerId]
        );
        if (!player) return fail(res, 'Mitglied nicht gefunden', 404);

        const [offices] = await pool.query('SELECT * FROM member_offices WHERE player_id = ? ORDER BY valid_from DESC', [playerId]);
        const [guardians] = await pool.query('SELECT * FROM guardians WHERE player_id = ? ORDER BY last_name', [playerId]);
        const [fees] = await pool.query('SELECT * FROM membership_fees WHERE player_id = ? ORDER BY year DESC', [playerId]);

        return res.json({ ...player, offices, guardians, fees });
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
          email, phone, birthDate, teamId,
          membershipNumber, membershipTypeId, status, joinedAt, leftAt, notes,
        } = req.body;

        let resolvedPlayerId = playerId ? Number(playerId) : null;

        if (resolvedPlayerId) {
          await pool.query(
            `UPDATE ${SHARED_DB}.players SET salutation=?, first_name=?, last_name=?, street=?, house_number=?,
               postal_code=?, city=?, email=?, phone=?, birth_date=?, team_id=? WHERE id=?`,
            [salutation || null, firstName, lastName, street || null, houseNumber || null, postalCode || null,
             city || null, email || null, phone || null, birthDate || null, teamId || null, resolvedPlayerId]
          );
        } else {
          const [result] = await pool.query(
            `INSERT INTO ${SHARED_DB}.players
               (salutation, first_name, last_name, street, house_number, postal_code, city, email, phone, birth_date, team_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [salutation || null, firstName, lastName, street || null, houseNumber || null, postalCode || null,
             city || null, email || null, phone || null, birthDate || null, teamId || null]
          );
          resolvedPlayerId = result.insertId;
        }

        const [[existingMembership]] = await pool.query('SELECT status FROM memberships WHERE player_id = ?', [resolvedPlayerId]);
        await pool.query(
          `INSERT INTO memberships (player_id, membership_number, membership_type_id, status, joined_at, left_at, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE membership_number=VALUES(membership_number), membership_type_id=VALUES(membership_type_id),
             status=VALUES(status), joined_at=VALUES(joined_at), left_at=VALUES(left_at), notes=VALUES(notes)`,
          [resolvedPlayerId, membershipNumber || null, membershipTypeId || null, status || 'ACTIVE',
           joinedAt || null, leftAt || null, notes || null]
        );

        if (existingMembership && existingMembership.status !== (status || 'ACTIVE')) {
          await writeAudit({
            userAccountId: req.user.userAccountId, tableName: 'memberships', recordId: resolvedPlayerId,
            fieldName: 'status', oldValue: existingMembership.status, newValue: status || 'ACTIVE',
          });
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
        const missing = requireFields(req.body, ['playerId', 'year', 'amountDue', 'dueDate']);
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
    password: process.env.DB_PASSWORD || 'change-me',
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
  app.listen(PORT, () => console.log(`Mitgliederverwaltung laeuft auf Port ${PORT}`));
}

start().catch(err => {
  console.error('Start fehlgeschlagen:', err);
  process.exit(1);
});
