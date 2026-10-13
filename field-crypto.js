// Feldverschluesselung fuer Bankdaten (Entscheidung 2026-10-13): IBAN und
// alte Kontonummer liegen in member_payment_details nur verschluesselt
// (AES-256-GCM, Schluessel aus IBAN_ENCRYPTION_KEY). Wer einen DB-Abzug in
// die Haende bekommt, sieht nur "enc:v1:..."-Werte. Entschluesselt wird
// ausschliesslich hier in member-management beim Lesen - die Anzeige
// (Verwaltung voll, Mein Bereich maskiert) bleibt unveraendert.
//
// ACHTUNG: Ohne den Schluessel sind die Werte unwiederbringlich verloren.
// Er gehoert deshalb in die Notfall-Zugangsdaten (wie SIGNATURE_ENCRYPTION_KEY
// in travel-expenses), NICHT ins Backup.
import crypto from 'crypto';

const PREFIX = 'enc:v1:';
const ENCRYPTED_COLUMNS = ['iban', 'account_number'];
let key = null;

export function initFieldCrypto(secret) {
  if (!secret || secret.length < 32) {
    throw new Error('IBAN_ENCRYPTION_KEY fehlt oder ist zu kurz (mind. 32 Zeichen, siehe .env.example)');
  }
  key = crypto.createHash('sha256').update(secret).digest();
}

export const isEncrypted = (value) => typeof value === 'string' && value.startsWith(PREFIX);

export function encryptField(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  if (isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

// Unverschluesselte Altwerte (vor der Migration) werden unveraendert
// durchgereicht, damit ein Start mitten in der Umstellung nichts kaputtmacht.
export function decryptField(value) {
  if (!isEncrypted(value)) return value ?? null;
  const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

export function decryptPaymentRow(row) {
  if (!row) return row;
  const out = { ...row };
  for (const col of ENCRYPTED_COLUMNS) if (col in out) out[col] = decryptField(out[col]);
  return out;
}

// Beim Start: (1) mit einem vorhandenen verschluesselten Wert pruefen, ob der
// Schluessel stimmt - mit falschem Schluessel wuerden sonst neue Werte unter
// einem anderen Schluessel landen und die Tabelle waere gemischt;
// (2) noch unverschluesselte Altwerte verschluesseln (idempotent).
export async function prepareEncryptedPaymentDetails(pool) {
  const [[probe]] = await pool.query(
    `SELECT player_id, iban, account_number FROM member_payment_details
     WHERE iban LIKE 'enc:v1:%' OR account_number LIKE 'enc:v1:%' LIMIT 1`
  );
  if (probe) {
    try {
      decryptPaymentRow(probe);
    } catch {
      throw new Error('IBAN_ENCRYPTION_KEY passt nicht zu den gespeicherten Bankdaten - Start abgebrochen (Schluessel pruefen, nichts veraendert)');
    }
  }
  const [rows] = await pool.query(
    `SELECT player_id, iban, account_number FROM member_payment_details
     WHERE (iban IS NOT NULL AND iban <> '' AND iban NOT LIKE 'enc:v1:%')
        OR (account_number IS NOT NULL AND account_number <> '' AND account_number NOT LIKE 'enc:v1:%')`
  );
  if (!rows.length) return 0;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const r of rows) {
      await conn.query(
        'UPDATE member_payment_details SET iban = ?, account_number = ? WHERE player_id = ?',
        [encryptField(r.iban), encryptField(r.account_number), r.player_id]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  console.log(`Bankdaten verschluesselt: ${rows.length} Datensaetze`);
  return rows.length;
}
