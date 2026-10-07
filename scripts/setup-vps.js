// VPS-Einrichtung per SSH + SFTP
// Verwendung: npm run setup-vps
// Liest Credentials aus .env (VPS_HOST, VPS_USER, VPS_PASSWORD)
//
// Der VPS betreibt bereits travel-expenses und mail-sorter, die sich einen
// zentralen Caddy-Reverse-Proxy (/opt/ssv-caddy) ueber das externe
// Docker-Netzwerk "ssv-shared" teilen. member-management zieht als dritte
// App dort ein - siehe travel-expenses' CLAUDE.md, Abschnitt "Gemeinsames
// Deployment mit mail-sorter".
//
// Betreibt bewusst KEINEN eigenen mariadb-Container - verbindet sich per
// Docker-DNS mit dem bereits laufenden travel-expenses-MariaDB-Container
// (ssv-travel-mariadb:3306), siehe CLAUDE.md, Abschnitt "Kein eigener
// MariaDB-Container". Die Datenbank ssv_member_management und der DB-User
// ssv_members muessen dafuer VORHER einmalig manuell angelegt sein (siehe
// scripts/grant-db-user.sql, README.md).
//
// Voraussetzung auf dem VPS: Docker ist bereits installiert (durch das
// initiale mail-sorter-Setup). Dieses Skript installiert Docker NICHT neu.

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import SftpClient from 'ssh2-sftp-client';

const require = createRequire(import.meta.url);
const { Client } = require('ssh2');

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = resolve(__dir, '..');

// ── .env einlesen ──────────────────────────────────────────────────────────────
const env = {};
readFileSync(resolve(ROOT, '.env'), 'utf8').split('\n').forEach(line => {
  const envMatch = line.match(/^\s*([^#][^=]+?)\s*=\s*(.+?)\s*$/);
  if (envMatch) env[envMatch[1]] = envMatch[2];
});

const HOST       = env['VPS_HOST'];
const USER       = env['VPS_USER'] || 'root';
const PASS       = env['VPS_PASSWORD'];
// Defaults = heutige SSV-Rhade-Installation, pro Installation ueberschreibbar
// (z.B. INSTANCE_REMOTE_DIR in .env) - ohne gesetzte Werte aendert sich an
// der laufenden Installation nichts.
const REMOTE_DIR = env['INSTANCE_REMOTE_DIR'] || '/opt/ssv-member-management';
const CADDY_DIR  = env['INSTANCE_CADDY_DIR']  || '/opt/ssv-caddy';
const NETWORK    = env['INSTANCE_NETWORK']    || 'ssv-shared';
const DOMAIN     = env['INSTANCE_DOMAIN']     || 'members.ssv-rhade.de';
const DB_HOST_CONTAINER = env['INSTANCE_DB_HOST_CONTAINER'] || 'ssv-travel-mariadb';
const APP_CONTAINER_NAME = env['INSTANCE_CONTAINER_NAME'] || 'ssv-member-management';

if (!HOST || !PASS) {
  console.error('VPS_HOST oder VPS_PASSWORD fehlt in .env (siehe .env.example - derselbe VPS wie travel-expenses)');
  process.exit(1);
}

// ── SSH-Helfer ─────────────────────────────────────────────────────────────────
function openSSH(password) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timeoutHandle = setTimeout(() => reject(new Error('SSH Timeout')), 20000);
    conn.on('ready', () => { clearTimeout(timeoutHandle); resolve(conn); });
    conn.on('error', err => { clearTimeout(timeoutHandle); reject(err); });
    conn.connect({ host: HOST, port: 22, username: USER, password, readyTimeout: 15000 });
  });
}

function run(conn, cmd, { stream = false } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, s) => {
      if (err) return reject(err);
      let out = '', errOut = '';
      s.on('data', chunk => { out += chunk; if (stream) process.stdout.write(String(chunk)); });
      s.stderr.on('data', chunk => { errOut += chunk; if (stream) process.stderr.write(String(chunk)); });
      s.on('close', code => resolve({ code, stdout: out, stderr: errOut }));
    });
  });
}

// ── SFTP-Helfer ────────────────────────────────────────────────────────────────
async function upload(sftp, localPath, remotePath) {
  const dir = remotePath.substring(0, remotePath.lastIndexOf('/'));
  await sftp.mkdir(dir, true);
  await sftp.put(localPath, remotePath);
  console.log(`  ✓ ${remotePath}`);
}

async function uploadContent(sftp, content, remotePath) {
  const dir = remotePath.substring(0, remotePath.lastIndexOf('/'));
  await sftp.mkdir(dir, true);
  await sftp.put(Buffer.from(content, 'utf8'), remotePath);
  console.log(`  ✓ ${remotePath} (generiert)`);
}

// Die gemeinsame Caddyfile wird von mehreren Apps auf demselben VPS
// gemeinsam genutzt. Nur den eigenen Domain-Block ergaenzen/aktualisieren,
// alle anderen Bloecke (travel-expenses, mail-sorter) bleiben unangetastet
// - siehe travel-expenses' setup-vps.js fuer denselben Mechanismus
// (dort verifiziert gegen den echten Produktions-Inhalt).
async function mergeCaddyBlock(sftp, remotePath, domain, upstreamContainer) {
  let existing = '';
  try {
    const buf = await sftp.get(remotePath);
    existing = buf.toString('utf8');
  } catch {
    // Datei existiert noch nicht
  }
  const escapedDomain = domain.replace(/\./g, '\\.');
  const blockRegex = new RegExp(`\\n?${escapedDomain} \\{[^}]*\\}\\n?`, 'g');
  const withoutOwnBlock = existing.replace(blockRegex, '').trim();
  const newBlock = `${domain} {\n  reverse_proxy ${upstreamContainer}:3000\n}`;
  const merged = (withoutOwnBlock ? withoutOwnBlock + '\n\n' : '') + newBlock + '\n';
  await uploadContent(sftp, merged, remotePath);
}

// ── Produktions-Konfiguration member-management ─────────────────────────────────
// Kein eigener mariadb-Service: DB_HOST zeigt per Docker-DNS auf den
// bereits laufenden travel-expenses-MariaDB-Container im gemeinsamen
// Netzwerk. Kein eigener caddy-Service: die zentrale Caddyfile (oben)
// routet direkt auf diesen Container-Namen.
const PROD_COMPOSE = `services:

  dashboard:
    build: .
    container_name: ${APP_CONTAINER_NAME}
    restart: unless-stopped
    expose:
      - "3000"
    environment:
      DB_HOST: ${DB_HOST_CONTAINER}
      DB_PORT: 3306
      DB_NAME: ssv_member_management
      DB_USER: ssv_members
      DB_PASSWORD: \${DB_PASSWORD}
      SHARED_DB_NAME: ssv_shared_members
      JWT_SECRET: \${JWT_SECRET}
      NODE_ENV: production
    networks:
      - default
      - ${NETWORK}

networks:
  ${NETWORK}:
    external: true
`;

// Bewusst NICHT die lokal genutzten DB_PASSWORD/JWT_SECRET-Variablen aus
// derselben .env wiederverwenden: anders als bei travel-expenses laeuft
// hier auch der lokale Dev-Server (npm start) direkt mit dieser .env -
// ein Ueberschreiben mit den Produktionswerten wuerde den naechsten
// lokalen Start mit falschen Zugangsdaten gegen die lokale DB laufen
// lassen. Eigene VPS_-praefigierte Variablen dafuer, siehe .env.example.
function buildProdEnv() {
  if (!env['VPS_DB_PASSWORD']) {
    console.error('VPS_DB_PASSWORD fehlt in .env (Passwort des ssv_members-Users auf dem VPS, siehe scripts/grant-db-user.sql dort)');
    process.exit(1);
  }
  return `# Datenbank - kein eigener Container, verbindet sich mit dem
# travel-expenses-MariaDB-Container im gemeinsamen Docker-Netzwerk.
# ssv_member_management + User ssv_members muessen dafuer vorher einmalig
# angelegt sein (siehe scripts/grant-db-user.sql).
DB_PASSWORD=${env['VPS_DB_PASSWORD']}

# Session-Token
JWT_SECRET=${env['VPS_JWT_SECRET'] || 'change-me'}
`;
}

const files = [
  ['Dockerfile',             `${REMOTE_DIR}/Dockerfile`],
  ['package.json',           `${REMOTE_DIR}/package.json`],
  ['server.js',              `${REMOTE_DIR}/server.js`],
  ['app/index.html',         `${REMOTE_DIR}/app/index.html`],
  ['app/assets/ssv-rhade-logo.png', `${REMOTE_DIR}/app/assets/ssv-rhade-logo.png`],
  ['db/00-schema.sql',       `${REMOTE_DIR}/db/00-schema.sql`],
];
if (existsSync(resolve(ROOT, 'package-lock.json'))) {
  files.push(['package-lock.json', `${REMOTE_DIR}/package-lock.json`]);
}

// ── Hauptprogramm ──────────────────────────────────────────────────────────────
console.log('\n=== SSV Mitgliederverwaltung – VPS Setup ===\n');

console.log(`Verbinde mit ${HOST}…`);
const conn = await openSSH(PASS);
console.log('✓ Verbunden\n');

console.log('Docker pruefen…');
const dockerCheck = await run(conn, 'docker --version 2>/dev/null && echo OK || echo MISSING');
if (dockerCheck.stdout.includes('MISSING')) {
  console.error('Docker ist auf dem VPS nicht installiert. Bitte zuerst travel-expenses/mail-sorters "npm run setup-vps" ausfuehren.');
  process.exit(1);
}
console.log('✓ Docker vorhanden\n');

console.log(`Gemeinsames Netzwerk "${NETWORK}" sicherstellen…`);
await run(conn, `docker network inspect ${NETWORK} >/dev/null 2>&1 || docker network create ${NETWORK}`);
console.log('✓ Netzwerk vorhanden\n');

console.log(`Verzeichnis anlegen: ${REMOTE_DIR}`);
await run(conn, `mkdir -p ${REMOTE_DIR}/app/assets ${REMOTE_DIR}/db`);
console.log('✓ Verzeichnis angelegt\n');
conn.end();

console.log('Dateien hochladen…');
const sftp = new SftpClient();
await sftp.connect({ host: HOST, port: 22, username: USER, password: PASS });

for (const [local, remote] of files) {
  const localPath = resolve(ROOT, local);
  if (!existsSync(localPath)) { console.log(`  [skip] ${local}`); continue; }
  await upload(sftp, localPath, remote);
}

await uploadContent(sftp, PROD_COMPOSE,   `${REMOTE_DIR}/docker-compose.yml`);
await uploadContent(sftp, buildProdEnv(), `${REMOTE_DIR}/.env`);
await mergeCaddyBlock(sftp, `${CADDY_DIR}/Caddyfile`, DOMAIN, APP_CONTAINER_NAME);

await sftp.end();
console.log('\n✓ Alle Dateien hochgeladen\n');

console.log('Zentralen Caddy (neu) starten, damit die neue Route greift…\n');
const conn2 = await openSSH(PASS);
await run(conn2, `cd ${CADDY_DIR} && docker compose up -d 2>&1`, { stream: true });

console.log('\nContainer member-management starten (erstes Mal 1-2 Minuten, bitte warten)…\n');
await run(conn2, `cd ${REMOTE_DIR} && docker compose up -d --build 2>&1`, { stream: true });

console.log('\nContainer-Status:');
const containerStatus = await run(conn2, `cd ${REMOTE_DIR} && docker compose ps`);
console.log(containerStatus.stdout);

console.log('\nServer-Log (erster Start erzeugt einmalig einen Admin-Zugang):');
await new Promise(r => setTimeout(r, 3000));
const logs = await run(conn2, `cd ${REMOTE_DIR} && docker compose logs --tail=20 dashboard`);
console.log(logs.stdout);

conn2.end();

console.log('=== Setup abgeschlossen ===');
console.log(`\nDashboard: https://${DOMAIN}`);
console.log('\nHinweis: DNS-A-Record fuer diese Domain auf die VPS-IP muss existieren,');
console.log('sonst kann Caddy kein Let\'s-Encrypt-Zertifikat ausstellen.');
console.log('\nBackup: laeuft ueber travel-expenses\' naechtlichen Cron-Job mit,');
console.log('siehe dortiges scripts/backup-db.sh (--databases um ssv_member_management ergaenzt).');
