// Aufbewahrung nach dem Austritt, Stufe 1 (Entscheidung 2026-10-09, siehe
// ssv-rhade/docs/aufbewahrung-vorschlag.md): Ausgetretene verschwinden aus
// allen Teams, die Zugehoerigkeit bleibt fuers Vereinsarchiv in
// member_team_history. Nichts wird geloescht, was nicht in der Historie steht.
//
// Aufgerufen vom Launchpad (Hintergrund-Job, nach einer Karenzzeit ab
// left_at) mit dem normalen Admin-Token - Tokens mit scope (Selbstbedienung)
// sind ausgeschlossen. Additiv: die Standalone-App nutzt diese Actions nicht.
import express from 'express';

export function createRetentionRouter({ pool, SHARED_DB, authenticate, fail, writeAudit }) {
  const router = express.Router();

  function adminAuth(req, res) {
    const user = authenticate(req);
    if (!user) { fail(res, 'Nicht angemeldet', 401); return null; }
    if (user.scope) { fail(res, 'Keine Berechtigung', 403); return null; }
    return user;
  }

  async function currentTeams(db, playerId) {
    const [rows] = await db.query(
      `SELECT pt.team_id, pt.joined_at, t.name FROM ${SHARED_DB}.player_teams pt
       JOIN ${SHARED_DB}.teams t ON t.id = pt.team_id WHERE pt.player_id = ?
       UNION
       SELECT p.team_id, NULL, t.name FROM ${SHARED_DB}.players p
       JOIN ${SHARED_DB}.teams t ON t.id = p.team_id
       WHERE p.id = ? AND p.team_id IS NOT NULL
         AND p.team_id NOT IN (SELECT team_id FROM ${SHARED_DB}.player_teams WHERE player_id = ?)`,
      [playerId, playerId, playerId]
    );
    return rows;
  }

  const handlers = {
    // Ausgetretene (left_at erreicht), noch mit Teamzuordnung bzw. Status je Person
    'GET retention-candidates': async (req, res) => {
      if (!adminAuth(req, res)) return;
      const [rows] = await pool.query(
        `SELECT m.player_id, p.first_name, p.last_name, m.left_at, m.teams_removed_at,
                DATEDIFF(CURDATE(), m.left_at) AS days_since_left
         FROM memberships m JOIN ${SHARED_DB}.players p ON p.id = m.player_id
         WHERE m.left_at IS NOT NULL AND m.left_at <= CURDATE()
         ORDER BY m.left_at, p.last_name`
      );
      const result = [];
      for (const r of rows) {
        result.push({
          playerId: r.player_id, firstName: r.first_name, lastName: r.last_name, leftAt: r.left_at,
          daysSinceLeft: r.days_since_left, teamsRemovedAt: r.teams_removed_at,
          teams: (await currentTeams(pool, r.player_id)).map(t => ({ id: t.team_id, name: t.name })),
        });
      }
      return res.json(result);
    },

    // Ab dem Austrittstag: players.active_until = left_at. Die Fahrtkosten-
    // Abrechnung erzeugt danach keine neuen Monate mehr fuer die Person
    // (generateMonth filtert ueber active_from/active_until). Idempotent; ein
    // frueheres, bewusst gesetztes active_until bleibt stehen.
    'POST member-mark-left': async (req, res) => {
      const user = adminAuth(req, res); if (!user) return;
      const playerId = Number(req.body.playerId);
      if (!playerId) return fail(res, 'playerId erforderlich');
      const [[m]] = await pool.query(
        'SELECT left_at, left_at <= CURDATE() AS has_left FROM memberships WHERE player_id = ?', [playerId]
      );
      if (!m?.left_at || !m.has_left) return fail(res, 'Die Person ist (noch) nicht ausgetreten', 409);
      const [r] = await pool.query(
        `UPDATE ${SHARED_DB}.players SET active_until = ? WHERE id = ? AND (active_until IS NULL OR active_until > ?)`,
        [m.left_at, playerId, m.left_at]
      );
      if (r.affectedRows) {
        await writeAudit({ userAccountId: user.userAccountId ?? null, tableName: 'players', recordId: playerId, fieldName: 'active_until (Austritt)', oldValue: null, newValue: m.left_at });
      }
      return res.json({ ok: true, activeUntil: m.left_at });
    },

    // Teamzugehoerigkeit in die Historie verschieben (idempotent)
    'POST member-remove-teams': async (req, res) => {
      const user = adminAuth(req, res); if (!user) return;
      const playerId = Number(req.body.playerId);
      if (!playerId) return fail(res, 'playerId erforderlich');
      const [[m]] = await pool.query(
        'SELECT left_at, left_at <= CURDATE() AS has_left FROM memberships WHERE player_id = ?', [playerId]
      );
      if (!m?.left_at || !m.has_left) return fail(res, 'Die Person ist (noch) nicht ausgetreten', 409);
      const conn = await pool.getConnection();
      let teams;
      try {
        await conn.beginTransaction();
        teams = await currentTeams(conn, playerId);
        if (teams.length) {
          await conn.query(
            `INSERT INTO member_team_history (player_id, team_id, team_name, joined_at, left_at)
             VALUES ${teams.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
            teams.flatMap(t => [playerId, t.team_id, t.name, t.joined_at, m.left_at])
          );
          await conn.query(`DELETE FROM ${SHARED_DB}.player_teams WHERE player_id = ?`, [playerId]);
          await conn.query(`UPDATE ${SHARED_DB}.players SET team_id = NULL WHERE id = ?`, [playerId]);
        }
        await conn.query(
          `UPDATE memberships SET status = 'TERMINATED', teams_removed_at = COALESCE(teams_removed_at, NOW()) WHERE player_id = ?`,
          [playerId]
        );
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
      if (teams.length) {
        await writeAudit({
          userAccountId: user.userAccountId ?? null, tableName: 'player_teams', recordId: playerId,
          fieldName: 'Teams (Austritt, in Historie verschoben)', oldValue: teams.map(t => t.name).join(', '), newValue: null,
        });
      }
      return res.json({ ok: true, teams: teams.map(t => ({ id: t.team_id, name: t.name })) });
    },

    // Stufe 2: Archivieren (Entscheidung 2026-10-10: pauschal archiveYears
    // nach dem Austritt, gerechnet bis Jahresende). Ins Vereinsarchiv kommen
    // NUR Vorname, Nachname, Teams (member_team_history) und Ehrungen (Titel
    // + Datum, ohne Notiz). Danach wird die Person in players geloescht - per
    // FK ON DELETE CASCADE verschwinden alle abhaengigen Daten in allen
    // Modulen. Vorher muss das Launchpad die Daten ohne FK entfernt haben.
    'POST member-archive': async (req, res) => {
      const user = adminAuth(req, res); if (!user) return;
      const playerId = Number(req.body.playerId);
      const years = Number(req.body.archiveYears);
      // reapply: nach einer Backup-Wiederherstellung erneut loeschen - nur
      // erlaubt, wenn die Person nachweislich schon archiviert wurde
      const reapply = req.body.reapply === true;
      if (!playerId || (!reapply && (!Number.isInteger(years) || years < 1))) return fail(res, 'playerId und archiveYears erforderlich');
      const [[m]] = await pool.query(
        `SELECT m.left_at, YEAR(m.left_at) + ? < YEAR(CURDATE()) AS due, p.first_name, p.last_name
         FROM ${SHARED_DB}.players p LEFT JOIN memberships m ON m.player_id = p.id WHERE p.id = ?`,
        [years || 0, playerId]
      );
      if (!m) return res.json({ ok: true, archived: { honors: 0, teams: 0 }, alreadyGone: true });
      if (reapply) {
        const [[known]] = await pool.query('SELECT 1 AS ok FROM member_archive WHERE person_ref = ?', [playerId]);
        if (!known) return fail(res, 'Wiederholung nur für bereits archivierte Personen', 409);
      } else {
        if (!m.left_at) return fail(res, 'Die Person ist nicht ausgetreten', 409);
        if (!m.due) return fail(res, 'Die Aufbewahrungsfrist ist noch nicht abgelaufen', 409);
      }
      const conn = await pool.getConnection();
      let honors, teams;
      try {
        await conn.beginTransaction();
        // Teams, die Stufe 1 noch nicht verschoben hat, ebenfalls ins Archiv
        // (bei der Wiederholung stehen sie dort schon)
        teams = await currentTeams(conn, playerId);
        if (teams.length && !reapply) {
          await conn.query(
            `INSERT INTO member_team_history (player_id, team_id, team_name, joined_at, left_at)
             VALUES ${teams.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
            teams.flatMap(t => [playerId, t.team_id, t.name, t.joined_at, m.left_at])
          );
        }
        // IGNORE: nach einer Backup-Wiederherstellung kann der Archiveintrag
        // schon existieren - dann Ehrungen nicht doppelt uebernehmen
        const [ins] = await conn.query(
          'INSERT IGNORE INTO member_archive (person_ref, first_name, last_name) VALUES (?, ?, ?)',
          [playerId, m.first_name, m.last_name]
        );
        [honors] = await conn.query('SELECT title, honor_date FROM member_honors WHERE player_id = ?', [playerId]);
        if (honors.length && ins.affectedRows) {
          await conn.query(
            `INSERT INTO member_archive_honors (person_ref, title, honor_date) VALUES ${honors.map(() => '(?, ?, ?)').join(', ')}`,
            honors.flatMap(h => [playerId, h.title, h.honor_date])
          );
        }
        // Eigenes Aenderungsprotokoll zur Person (enthaelt alte Werte)
        await conn.query(
          `DELETE FROM audit_log WHERE (record_id = ? AND table_name IN ('players','memberships','member_payment_details','member_consents','player_teams'))
             OR (table_name = 'membership_fees' AND record_id IN (SELECT id FROM membership_fees WHERE player_id = ?))`,
          [playerId, playerId]
        );
        await conn.query(`DELETE FROM ${SHARED_DB}.players WHERE id = ?`, [playerId]);
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
      return res.json({ ok: true, archived: { honors: honors.length, teams: teams.length } });
    },

    // Vereinsarchiv (nur fuer die Verwaltung)
    'GET member-archive-list': async (req, res) => {
      if (!adminAuth(req, res)) return;
      const [rows] = await pool.query(
        `SELECT a.person_ref, a.first_name, a.last_name, a.archived_at,
                (SELECT GROUP_CONCAT(DISTINCT h.team_name ORDER BY h.team_name SEPARATOR ', ') FROM member_team_history h WHERE h.player_id = a.person_ref) AS teams,
                (SELECT GROUP_CONCAT(CONCAT(x.title, IFNULL(CONCAT(' (', YEAR(x.honor_date), ')'), '')) SEPARATOR ', ') FROM member_archive_honors x WHERE x.person_ref = a.person_ref) AS honors
         FROM member_archive a ORDER BY a.last_name, a.first_name`
      );
      return res.json(rows.map(r => ({ ref: r.person_ref, firstName: r.first_name, lastName: r.last_name, archivedAt: r.archived_at, teams: r.teams, honors: r.honors })));
    },

    // Team-Historie einer Person (Archiv)
    'GET member-team-history': async (req, res) => {
      if (!adminAuth(req, res)) return;
      const playerId = Number(req.query.playerId);
      if (!playerId) return fail(res, 'playerId erforderlich');
      const [rows] = await pool.query(
        'SELECT team_id, team_name, joined_at, left_at FROM member_team_history WHERE player_id = ? ORDER BY left_at DESC, team_name',
        [playerId]
      );
      return res.json(rows.map(r => ({ teamId: r.team_id, teamName: r.team_name, joinedAt: r.joined_at, leftAt: r.left_at })));
    },
  };

  const dispatch = (method) => async (req, res, next) => {
    const action = method === 'GET' ? req.query.action : req.body?.action;
    const handler = handlers[`${method} ${action}`];
    if (!handler) return next();
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`${method} /api action=${action} fehlgeschlagen:`, err);
      if (!res.headersSent) fail(res, 'Interner Fehler', 500);
    }
  };
  router.get('/api', dispatch('GET'));
  router.post('/api', dispatch('POST'));
  return router;
}
