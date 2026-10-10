// Mitglieder-Selbstbedienung und Einwilligungen - rein additiv zur
// bestehenden Admin-API in server.js (siehe CLAUDE.md, Abschnitt
// "Selbstbedienung fuer das Launchpad").
//
// Aufrufer ist ausschliesslich das Launchpad, serverseitig mit einem kurz
// gueltigen Token ({ scope: 'self', playerId, launchpadAccountId }), das nie
// den Browser erreicht. Ein Token MIT scope darf nur die 'self-*'-Actions
// dieser Datei nutzen - die Admin-Actions in server.js lehnen jeden Token mit
// scope ab. So wird aus einem Self-Token nie ein Admin-Zugriff.
//
// Fachregeln (Nutzer-Entscheidungen 2026-10-08, Aufnahmeantrag):
// - Adresse/Kontakt/IBAN aendert das Mitglied selbst, ohne Freigabe.
// - Neue IBAN nur mit online bestaetigtem SEPA-Mandatstext.
// - Einwilligungen (Kontaktdaten-Weitergabe, Fotos/Videos) jederzeit
//   widerrufbar; online ERTEILEN nur fuer Volljaehrige (bei Minderjaehrigen
//   braucht es laut Antrag zusaetzlich die gesetzlichen Vertreter -> Papier
//   ueber die Verwaltung).
// - Austritt setzt left_at auf den vom Launchpad berechneten Termin; die
//   Mitgliedschaft bleibt bis dahin ACTIVE. Ruecknahme loescht ihn wieder.
import express from 'express';

export const CONSENT_TYPES = ['CONTACT_SHARING', 'MEDIA'];
const ADULT_AGE = 18;

// ── Validierung ──────────────────────────────────────────────────────────
const clean = (v, max) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[+0-9 ()/-]{4,30}$/;

export function normalizeIban(value) {
  return String(value ?? '').replace(/\s+/g, '').toUpperCase();
}

// ISO 13616: Laendercode + Pruefziffer ans Ende, Buchstaben -> Zahlen, mod 97 == 1
export function isValidIban(iban) {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  if (iban.startsWith('DE') && iban.length !== 22) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, ch => String(ch.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}

export const maskIban = (iban) => (iban ? `${iban.slice(0, 4)} **** **** ${iban.slice(-4)}` : null);

function ageOn(birthDate, day = new Date()) {
  if (!birthDate) return null;
  const b = new Date(`${birthDate}T00:00:00`);
  let age = day.getFullYear() - b.getFullYear();
  if (day.getMonth() < b.getMonth() || (day.getMonth() === b.getMonth() && day.getDate() < b.getDate())) age--;
  return age;
}

// Aktueller Stand je Einwilligungsart = juengster Eintrag (Historie bleibt erhalten)
async function loadConsents(pool, playerId) {
  const [rows] = await pool.query(
    `SELECT c.* FROM member_consents c
     JOIN (SELECT consent_type, MAX(id) AS id FROM member_consents WHERE player_id = ? GROUP BY consent_type) last
       ON last.id = c.id`,
    [playerId]
  );
  return CONSENT_TYPES.map((type) => {
    const row = rows.find(r => r.consent_type === type);
    return {
      type,
      granted: row ? !!row.granted : false,
      recorded: !!row,
      changedAt: row?.created_at ?? null,
      source: row?.source ?? null,
      guardianConsent: row ? !!row.guardian_consent : false,
    };
  });
}

// Eingangswege einer Kuendigung, die das Launchpad abwickelt
const TERMINATION_SOURCES = { ONLINE: 'online', MAIL: 'per E-Mail, per Link bestätigt', MAIL_PDF: 'per E-Mail mit PDF' };

export function createSelfServiceRouter({ pool, SHARED_DB, authenticate, fail, writeAudit }) {
  const router = express.Router();

  // Aenderungen feldweise ins Audit (user_account_id = NULL, weil kein Konto
  // dieser App; das Launchpad protokolliert zusaetzlich mit Handelndem).
  async function auditChanges(table, recordId, before, after, fields) {
    for (const f of fields) {
      const oldValue = before?.[f] ?? null;
      const newValue = after[f] ?? null;
      if (String(oldValue ?? '') === String(newValue ?? '')) continue;
      await writeAudit({ userAccountId: null, tableName: table, recordId, fieldName: `${f} (Selbstbedienung)`, oldValue, newValue });
    }
  }

  function selfAuth(req, res) {
    const user = authenticate(req);
    if (!user || user.scope !== 'self' || !Number(user.playerId)) {
      fail(res, 'Nicht angemeldet', 401);
      return null;
    }
    return user;
  }

  function adminAuth(req, res) {
    const user = authenticate(req);
    if (!user) { fail(res, 'Nicht angemeldet', 401); return null; }
    if (user.scope) { fail(res, 'Keine Berechtigung', 403); return null; }
    return user;
  }

  const handlers = {
    // ── Selbstbedienung (scope 'self') ─────────────────────────────────
    'GET self-profile': async (req, res) => {
      const user = selfAuth(req, res); if (!user) return;
      const playerId = Number(user.playerId);
      const [[p]] = await pool.query(
        `SELECT id, salutation, first_name, last_name, gender, birth_date, street, house_number, postal_code, city,
                email, phone, mobile_phone FROM ${SHARED_DB}.players WHERE id = ?`, [playerId]
      );
      if (!p) return fail(res, 'Person nicht gefunden', 404);
      const [[pay]] = await pool.query(
        'SELECT iban, bic, account_holder, mandate_reference, mandate_date, mandate_confirmed_online_at FROM member_payment_details WHERE player_id = ?',
        [playerId]
      );
      const [[m]] = await pool.query(
        `SELECT m.status, m.joined_at, m.left_at, m.membership_number, m.termination_requested_at, m.termination_source,
                t.name AS type_name
         FROM memberships m LEFT JOIN membership_types t ON t.id = m.membership_type_id WHERE m.player_id = ?`,
        [playerId]
      );
      const [teams] = await pool.query(
        `SELECT t.name FROM ${SHARED_DB}.player_teams pt JOIN ${SHARED_DB}.teams t ON t.id = pt.team_id WHERE pt.player_id = ? ORDER BY t.name`,
        [playerId]
      );
      return res.json({
        person: {
          playerId: p.id, salutation: p.salutation, firstName: p.first_name, lastName: p.last_name, gender: p.gender,
          birthDate: p.birth_date, street: p.street, houseNumber: p.house_number, postalCode: p.postal_code, city: p.city,
          email: p.email, phone: p.phone, mobilePhone: p.mobile_phone, age: ageOn(p.birth_date),
        },
        payment: {
          ibanMasked: maskIban(pay?.iban), bic: pay?.bic ?? null, accountHolder: pay?.account_holder ?? null,
          mandateReference: pay?.mandate_reference ?? null, mandateDate: pay?.mandate_date ?? null,
          mandateConfirmedOnlineAt: pay?.mandate_confirmed_online_at ?? null,
        },
        membership: m ? {
          status: m.status, joinedAt: m.joined_at, leftAt: m.left_at, membershipNumber: m.membership_number,
          typeName: m.type_name, terminationRequestedAt: m.termination_requested_at, terminationSource: m.termination_source,
        } : null,
        teams: teams.map(t => t.name),
        consents: await loadConsents(pool, playerId),
      });
    },

    'POST self-update-contact': async (req, res) => {
      const user = selfAuth(req, res); if (!user) return;
      const playerId = Number(user.playerId);
      const b = req.body;
      const values = {
        street: clean(b.street, 150), house_number: clean(b.houseNumber, 20), postal_code: clean(b.postalCode, 10),
        city: clean(b.city, 100), email: clean(b.email, 255), phone: clean(b.phone, 30), mobile_phone: clean(b.mobilePhone, 30),
      };
      if (!values.street || !values.house_number || !values.postal_code || !values.city) return fail(res, 'Straße, Hausnummer, PLZ und Ort sind Pflichtangaben');
      if (!/^[0-9A-Za-z -]{4,10}$/.test(values.postal_code)) return fail(res, 'Ungültige Postleitzahl');
      if (values.email && !EMAIL.test(values.email)) return fail(res, 'Ungültige E-Mail-Adresse');
      for (const f of ['phone', 'mobile_phone']) if (values[f] && !PHONE.test(values[f])) return fail(res, 'Ungültige Telefonnummer');
      const [[before]] = await pool.query(
        `SELECT street, house_number, postal_code, city, email, phone, mobile_phone FROM ${SHARED_DB}.players WHERE id = ?`, [playerId]
      );
      if (!before) return fail(res, 'Person nicht gefunden', 404);
      await pool.query(
        `UPDATE ${SHARED_DB}.players SET street=?, house_number=?, postal_code=?, city=?, email=?, phone=?, mobile_phone=? WHERE id=?`,
        [values.street, values.house_number, values.postal_code, values.city, values.email, values.phone, values.mobile_phone, playerId]
      );
      const fields = Object.keys(values);
      await auditChanges('players', playerId, before, values, fields);
      const changed = fields.filter(f => String(before[f] ?? '') !== String(values[f] ?? ''));
      return res.json({ ok: true, changed, before, after: values });
    },

    'POST self-update-bank': async (req, res) => {
      const user = selfAuth(req, res); if (!user) return;
      const playerId = Number(user.playerId);
      const iban = normalizeIban(req.body.iban);
      const bic = clean(req.body.bic, 11)?.replace(/\s+/g, '').toUpperCase() ?? null;
      const accountHolder = clean(req.body.accountHolder, 150);
      if (!isValidIban(iban)) return fail(res, 'Die IBAN ist ungültig – bitte Eingabe prüfen');
      if (bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) return fail(res, 'Ungültige BIC');
      if (!accountHolder) return fail(res, 'Kontoinhaber ist eine Pflichtangabe');
      if (req.body.mandateAccepted !== true) return fail(res, 'Bitte das SEPA-Lastschriftmandat bestätigen');
      const [[before]] = await pool.query('SELECT iban, bic, account_holder FROM member_payment_details WHERE player_id = ?', [playerId]);
      await pool.query(
        `INSERT INTO member_payment_details (player_id, iban, bic, account_holder, mandate_confirmed_online_at)
         VALUES (?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE iban = VALUES(iban), bic = VALUES(bic), account_holder = VALUES(account_holder),
           mandate_confirmed_online_at = NOW()`,
        [playerId, iban, bic, accountHolder]
      );
      // IBAN nie im Klartext ins Protokoll (Datenminimierung, Entscheidung
      // 2026-10-10): Aenderung am echten Wert erkennen, aber maskiert speichern
      if ((before?.iban ?? '') !== iban) {
        await writeAudit({ userAccountId: null, tableName: 'member_payment_details', recordId: playerId, fieldName: 'iban (Selbstbedienung)', oldValue: maskIban(before?.iban), newValue: maskIban(iban) });
      }
      await auditChanges('member_payment_details', playerId, before, { bic, account_holder: accountHolder }, ['bic', 'account_holder']);
      return res.json({ ok: true, ibanMasked: maskIban(iban), previousIbanMasked: maskIban(before?.iban) });
    },

    'POST self-consent': async (req, res) => {
      const user = selfAuth(req, res); if (!user) return;
      const playerId = Number(user.playerId);
      const type = req.body.type;
      const granted = req.body.granted === true;
      if (!CONSENT_TYPES.includes(type)) return fail(res, 'Unbekannte Einwilligung');
      if (granted) {
        const [[p]] = await pool.query(`SELECT birth_date FROM ${SHARED_DB}.players WHERE id = ?`, [playerId]);
        const age = ageOn(p?.birth_date);
        if (age === null || age < ADULT_AGE) {
          return fail(res, 'Bei Minderjährigen wird die Einwilligung über die Geschäftsstelle erteilt (Unterschrift der gesetzlichen Vertreter nötig)', 403);
        }
      }
      await pool.query(
        'INSERT INTO member_consents (player_id, consent_type, granted, source, recorded_by_launchpad_account_id) VALUES (?, ?, ?, ?, ?)',
        [playerId, type, granted ? 1 : 0, 'ONLINE', user.launchpadAccountId ?? null]
      );
      await writeAudit({ userAccountId: null, tableName: 'member_consents', recordId: playerId, fieldName: `${type} (Selbstbedienung)`, oldValue: null, newValue: granted ? 'erteilt' : 'widerrufen' });
      return res.json({ ok: true, consents: await loadConsents(pool, playerId) });
    },

    // Austritt: Termin berechnet das Launchpad (Kuendigungsregeln des Vereins)
    'POST self-terminate': async (req, res) => {
      const user = selfAuth(req, res); if (!user) return;
      const playerId = Number(user.playerId);
      const leftAt = String(req.body.leftAt ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(leftAt)) return fail(res, 'Ungültiges Austrittsdatum');
      // Eingangsweg und -tag legt das Launchpad fest (Kuendigung im Launchpad,
      // per Mail mit PDF oder per Mail mit Bestaetigungslink); massgeblich
      // fuer die Frist ist der Eingang, nicht die Bestaetigung.
      const source = Object.hasOwn(TERMINATION_SOURCES, req.body.source) ? req.body.source : 'ONLINE';
      const requestedOn = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.requestedOn ?? '')) ? req.body.requestedOn : null;
      const [[m]] = await pool.query('SELECT status, left_at FROM memberships WHERE player_id = ?', [playerId]);
      if (!m) return fail(res, 'Keine Mitgliedschaft gefunden', 404);
      if (m.status !== 'ACTIVE') return fail(res, 'Die Mitgliedschaft ist nicht aktiv');
      if (m.left_at) return fail(res, 'Für diese Mitgliedschaft ist bereits ein Austritt eingetragen', 409);
      await pool.query(
        `UPDATE memberships SET left_at = ?, exit_reason = ?, termination_requested_at = COALESCE(?, NOW()),
           termination_source = ? WHERE player_id = ?`,
        [leftAt, `Kündigung (${TERMINATION_SOURCES[source]})`, requestedOn, source, playerId]
      );
      await writeAudit({ userAccountId: null, tableName: 'memberships', recordId: playerId, fieldName: `left_at (Kündigung ${TERMINATION_SOURCES[source]})`, oldValue: null, newValue: leftAt });
      return res.json({ ok: true, leftAt });
    },

    // Ruecknahme einer ueber das Launchpad abgewickelten Kuendigung (Frist prueft das Launchpad)
    'POST self-terminate-withdraw': async (req, res) => {
      const user = selfAuth(req, res); if (!user) return;
      const playerId = Number(user.playerId);
      const [[m]] = await pool.query('SELECT left_at, termination_source FROM memberships WHERE player_id = ?', [playerId]);
      if (!m?.left_at || !Object.hasOwn(TERMINATION_SOURCES, m.termination_source ?? '')) return fail(res, 'Keine über das Launchpad abgewickelte Kündigung vorhanden', 409);
      await pool.query(
        `UPDATE memberships SET left_at = NULL, exit_reason = NULL, termination_requested_at = NULL, termination_source = NULL
         WHERE player_id = ?`,
        [playerId]
      );
      await writeAudit({ userAccountId: null, tableName: 'memberships', recordId: playerId, fieldName: 'left_at (Kündigung zurückgenommen)', oldValue: m.left_at, newValue: null });
      return res.json({ ok: true });
    },

    // ── Verwaltung (normaler Admin-Token, kein scope) ───────────────────
    // Aenderungsprotokoll dieser App zu einer Person (fuer die Historie im
    // Launchpad, dort nur mit audit.read). Gleiche Tabellenauswahl wie beim
    // Loeschen in retention.js member-archive.
    'GET member-audit': async (req, res) => {
      if (!adminAuth(req, res)) return;
      const playerId = Number(req.query.playerId);
      if (!playerId) return fail(res, 'playerId erforderlich');
      const [rows] = await pool.query(
        `SELECT a.id, a.table_name, a.record_id, a.field_name, a.old_value, a.new_value, a.changed_at, u.username
         FROM audit_log a LEFT JOIN user_accounts u ON u.id = a.user_account_id
         WHERE (a.record_id = ? AND a.table_name IN ('players','memberships','member_payment_details','member_consents','player_teams'))
            OR (a.table_name = 'membership_fees' AND a.record_id IN (SELECT id FROM membership_fees WHERE player_id = ?))
         ORDER BY a.changed_at DESC, a.id DESC LIMIT 500`,
        [playerId, playerId]
      );
      return res.json(rows.map(r => ({
        id: r.id, table: r.table_name, recordId: r.record_id, field: r.field_name,
        oldValue: r.old_value, newValue: r.new_value, at: r.changed_at, user: r.username,
      })));
    },

    'GET member-consents': async (req, res) => {
      if (!adminAuth(req, res)) return;
      const playerId = Number(req.query.playerId);
      if (!playerId) return fail(res, 'playerId erforderlich');
      const [history] = await pool.query(
        'SELECT consent_type, granted, guardian_consent, source, note, created_at FROM member_consents WHERE player_id = ? ORDER BY id DESC',
        [playerId]
      );
      return res.json({ consents: await loadConsents(pool, playerId), history });
    },

    // Erfassung vom Papierantrag (inkl. Unterschrift der Eltern bei Minderjaehrigen)
    'POST member-consent': async (req, res) => {
      const user = adminAuth(req, res); if (!user) return;
      const playerId = Number(req.body.playerId);
      const type = req.body.type;
      if (!playerId || !CONSENT_TYPES.includes(type)) return fail(res, 'playerId und gültige Einwilligung erforderlich');
      await pool.query(
        `INSERT INTO member_consents (player_id, consent_type, granted, guardian_consent, source, note, recorded_by_user_account_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [playerId, type, req.body.granted ? 1 : 0, req.body.guardianConsent ? 1 : 0,
          ['PAPER', 'ADMIN'].includes(req.body.source) ? req.body.source : 'PAPER', clean(req.body.note, 500), user.userAccountId ?? null]
      );
      await writeAudit({ userAccountId: user.userAccountId ?? null, tableName: 'member_consents', recordId: playerId, fieldName: type, oldValue: null, newValue: req.body.granted ? 'erteilt' : 'widerrufen' });
      return res.json({ ok: true, consents: await loadConsents(pool, playerId) });
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
