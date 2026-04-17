const http = require('http');
const fs = require('fs');
const https = require('https');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');
import express from 'express';
import path from 'path';

const app = express();

app.use(express.static('.'));
// BU ŞART
app.use(express.static(path.join(process.cwd())));

function loadDotEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8').replace(/^\\uFEFF/, '');
  raw.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const sepIndex = trimmed.indexOf('=');
    if (sepIndex < 1) return;
    const key = trimmed.slice(0, sepIndex).trim();
    if (!key || process.env[key] !== undefined) return;
    let value = trimmed.slice(sepIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  });
}

loadDotEnvFile();
let nodemailer = null;
try {
  // Optional at runtime until `npm install` is run.
  nodemailer = require('nodemailer');
} catch (_err) {}

const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const RESET_TOKEN_TTL_MS = 1000 * 60 * 30;
const DEFAULT_ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@serifkuray.com').trim().toLowerCase();
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'serif2026';
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const WHATSAPP_ENABLED = String(process.env.WHATSAPP_ENABLED || 'false').trim().toLowerCase() === 'true';
const WHATSAPP_ACCESS_TOKEN = String(process.env.WHATSAPP_ACCESS_TOKEN || '').trim();
const WHATSAPP_PHONE_NUMBER_ID = String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
const WHATSAPP_NOTIFY_TO = String(process.env.WHATSAPP_NOTIFY_TO || '').trim();
const WHATSAPP_TEMPLATE_NAME = String(process.env.WHATSAPP_TEMPLATE_NAME || 'randevu_bildirimi').trim();
const WHATSAPP_TEMPLATE_LANG = String(process.env.WHATSAPP_TEMPLATE_LANG || 'tr').trim();
const WHATSAPP_API_VERSION = String(process.env.WHATSAPP_API_VERSION || 'v18.0').trim();
const WEB_PUSH_ENABLED = String(process.env.WEB_PUSH_ENABLED || 'false').trim().toLowerCase() === 'true';
const WEB_PUSH_SUBJECT = String(process.env.WEB_PUSH_SUBJECT || 'mailto:admin@serifkuray.com').trim();
const WEB_PUSH_PUBLIC_KEY = String(process.env.WEB_PUSH_PUBLIC_KEY || '').trim();
const WEB_PUSH_PRIVATE_KEY = String(process.env.WEB_PUSH_PRIVATE_KEY || '').trim();
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const APPOINTMENTS_FILE = path.join(DATA_DIR, 'appointments.json');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const PUSH_SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');
const MASTER_NAMES = ['Şerif Kuray', 'Murat Bulut', 'Ömer Cafoğlu'];

const sessions = new Map();
const eventClients = new Set();

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function normalizePathname(pathname) {
  return pathname.replace(/\/+$/, '') || '/';
}

function parseCookies(req) {
  const source = req.headers.cookie || '';
  const out = {};
  source.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}

function setAuthCookie(res, token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie', `admin_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', 'admin_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function pruneSessions() {
  const now = Date.now();
  for (const [token, expiresAt] of sessions.entries()) {
    if (expiresAt <= now) sessions.delete(token);
  }
}

function getAuthToken(req) {
  const cookies = parseCookies(req);
  return cookies.admin_token || '';
}

function isAdminAuthenticated(req) {
  pruneSessions();
  const token = getAuthToken(req);
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return true;
}

function requireAdmin(req, res) {
  if (!isAdminAuthenticated(req)) {
    sendJson(res, 401, { error: 'Yetkisiz istek.' });
    return false;
  }
  return true;
}

async function readBodyJSON(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_err) {
    throw new Error('Gecersiz JSON gonderimi.');
  }
}

function normalizeEmail(value) {
  return cleanString(value).toLowerCase();
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function createPasswordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, hash) {
  if (!password || !salt || !hash) return false;
  const computed = createPasswordHash(password, salt);
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function ensureDataFiles() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  if (!fs.existsSync(APPOINTMENTS_FILE)) {
    await fsp.writeFile(APPOINTMENTS_FILE, '[]', 'utf8');
  }
  if (!fs.existsSync(PUSH_SUBSCRIPTIONS_FILE)) {
    await fsp.writeFile(PUSH_SUBSCRIPTIONS_FILE, '[]', 'utf8');
  }
  if (!fs.existsSync(ADMIN_FILE)) {
    const salt = crypto.randomBytes(16).toString('hex');
    const admin = {
      email: DEFAULT_ADMIN_EMAIL,
      passwordSalt: salt,
      passwordHash: createPasswordHash(DEFAULT_ADMIN_PASSWORD, salt),
      resetTokenHash: null,
      resetExpiresAt: null,
      updatedAt: new Date().toISOString()
    };
    await fsp.writeFile(ADMIN_FILE, JSON.stringify(admin, null, 2), 'utf8');
  }
}

async function readAppointments() {
  await ensureDataFiles();
  const raw = await fsp.readFile(APPOINTMENTS_FILE, 'utf8');
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (_err) {
    return [];
  }
}

async function writeAppointments(items) {
  await ensureDataFiles();
  await fsp.writeFile(APPOINTMENTS_FILE, JSON.stringify(items, null, 2), 'utf8');
}

async function readPushSubscriptions() {
  await ensureDataFiles();
  const raw = await fsp.readFile(PUSH_SUBSCRIPTIONS_FILE, 'utf8');
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (_err) {
    return [];
  }
}

async function writePushSubscriptions(items) {
  await ensureDataFiles();
  await fsp.writeFile(PUSH_SUBSCRIPTIONS_FILE, JSON.stringify(items, null, 2), 'utf8');
}

async function readAdmin() {
  await ensureDataFiles();
  const raw = await fsp.readFile(ADMIN_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    email: normalizeEmail(parsed.email || DEFAULT_ADMIN_EMAIL),
    passwordSalt: cleanString(parsed.passwordSalt),
    passwordHash: cleanString(parsed.passwordHash),
    resetTokenHash: parsed.resetTokenHash ? cleanString(parsed.resetTokenHash) : null,
    resetExpiresAt: parsed.resetExpiresAt || null,
    updatedAt: parsed.updatedAt || null
  };
}

async function writeAdmin(admin) {
  await ensureDataFiles();
  const normalized = {
    email: normalizeEmail(admin.email || DEFAULT_ADMIN_EMAIL),
    passwordSalt: cleanString(admin.passwordSalt),
    passwordHash: cleanString(admin.passwordHash),
    resetTokenHash: admin.resetTokenHash ? cleanString(admin.resetTokenHash) : null,
    resetExpiresAt: admin.resetExpiresAt || null,
    updatedAt: admin.updatedAt || new Date().toISOString()
  };
  await fsp.writeFile(ADMIN_FILE, JSON.stringify(normalized, null, 2), 'utf8');
}

function getMailConfig() {
  const host = cleanString(process.env.SMTP_HOST);
  const port = Number(process.env.SMTP_PORT || 0);
  const user = cleanString(process.env.SMTP_USER);
  const pass = cleanString(process.env.SMTP_PASS);
  const from = cleanString(process.env.SMTP_FROM || user);
  if (!host || !port || !user || !pass || !from) {
    return null;
  }
  return {
    host,
    port,
    secure: cleanString(process.env.SMTP_SECURE).toLowerCase() === 'true' || port === 465,
    auth: { user, pass },
    from
  };
}

async function sendResetMail(toEmail, resetLink) {
  if (!nodemailer) {
    throw new Error('Mail servisi icin nodemailer kurulumu eksik.');
  }
  const cfg = getMailConfig();
  if (!cfg) {
    throw new Error('SMTP ayarlari eksik.');
  }
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.auth
  });
  await transporter.sendMail({
    from: cfg.from,
    to: toEmail,
    subject: 'Serif Kuray Admin Sifre Sifirlama',
    text: `Sifrenizi yenilemek icin bu baglantiyi kullanin: ${resetLink}\nBaglanti 30 dakika gecerlidir.`,
    html: `<p>Sifrenizi yenilemek icin <a href="${resetLink}">buraya tiklayin</a>.</p><p>Baglanti 30 dakika gecerlidir.</p>`
  });
}

function cleanString(value) {
  return String(value || '').trim();
}

function normalizePhoneNumber(value) {
  const digits = cleanString(value).replace(/[^\d]/g, '');
  if (!digits) return '';
  return digits.startsWith('00') ? digits.slice(2) : digits;
}

function formatAppointmentDateTR(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const [year, month, day] = value.split('-');
  return `${day}.${month}.${year}`;
}

function getWebPushConfig() {
  if (!WEB_PUSH_ENABLED) return null;
  if (!WEB_PUSH_PUBLIC_KEY || !WEB_PUSH_PRIVATE_KEY || !WEB_PUSH_SUBJECT) return null;
  return {
    publicKey: WEB_PUSH_PUBLIC_KEY,
    privateKey: WEB_PUSH_PRIVATE_KEY,
    subject: WEB_PUSH_SUBJECT
  };
}

function normalizePushSubscription(input) {
  const endpoint = cleanString(input?.endpoint);
  const keys = input?.keys || {};
  const p256dh = cleanString(keys.p256dh);
  const auth = cleanString(keys.auth);
  if (!endpoint || !p256dh || !auth) return null;
  return {
    endpoint,
    expirationTime: input?.expirationTime ?? null,
    keys: { p256dh, auth }
  };
}

async function savePushSubscription(subscription) {
  const normalized = normalizePushSubscription(subscription);
  if (!normalized) throw new Error('Gecersiz bildirim aboneligi.');
  const list = await readPushSubscriptions();
  const existingIndex = list.findIndex(item => item.endpoint === normalized.endpoint);
  if (existingIndex >= 0) {
    list[existingIndex] = normalized;
  } else {
    list.push(normalized);
  }
  await writePushSubscriptions(list);
  return normalized;
}

async function removePushSubscriptionByEndpoint(endpoint) {
  const cleanEndpoint = cleanString(endpoint);
  if (!cleanEndpoint) return false;
  const list = await readPushSubscriptions();
  const next = list.filter(item => item.endpoint !== cleanEndpoint);
  if (next.length === list.length) return false;
  await writePushSubscriptions(next);
  return true;
}

function createAppointmentPushPayload(appointment) {
  return JSON.stringify({
    title: 'Yeni Randevu Talebi',
    body: `${appointment.name} - ${appointment.service} - ${formatAppointmentDateTR(appointment.date)} ${appointment.time}`,
    tag: `appointment-${appointment.id}`,
    url: '/admin',
    appointment: {
      id: appointment.id,
      name: appointment.name,
      service: appointment.service,
      date: appointment.date,
      time: appointment.time,
      master: appointment.master,
      phone: appointment.phone
    }
  });
}

async function sendAppointmentPushNotifications(appointment) {
  const cfg = getWebPushConfig();
  if (!cfg) return { skipped: true };

  webpush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey);

  const subscriptions = await readPushSubscriptions();
  if (!subscriptions.length) return { sent: 0, removed: 0 };

  const staleEndpoints = new Set();
  let sent = 0;
  const payload = createAppointmentPushPayload(appointment);

  await Promise.all(subscriptions.map(async subscription => {
    try {
      await webpush.sendNotification(subscription, payload);
      sent += 1;
    } catch (err) {
      const statusCode = err?.statusCode || err?.status || 0;
      if (statusCode === 404 || statusCode === 410) {
        staleEndpoints.add(subscription.endpoint);
        return;
      }
      throw err;
    }
  }));

  if (staleEndpoints.size) {
    const activeSubscriptions = subscriptions.filter(item => !staleEndpoints.has(item.endpoint));
    await writePushSubscriptions(activeSubscriptions);
  }

  return { sent, removed: staleEndpoints.size };
}

function getWhatsAppConfig() {
  if (!WHATSAPP_ENABLED) return null;
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_NOTIFY_TO || !WHATSAPP_TEMPLATE_NAME || !WHATSAPP_TEMPLATE_LANG || !WHATSAPP_API_VERSION) {
    return null;
  }
  return {
    accessToken: WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: WHATSAPP_PHONE_NUMBER_ID,
    notifyTo: normalizePhoneNumber(WHATSAPP_NOTIFY_TO),
    templateName: WHATSAPP_TEMPLATE_NAME,
    templateLang: WHATSAPP_TEMPLATE_LANG,
    apiVersion: WHATSAPP_API_VERSION
  };
}

function postJson(urlString, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(urlString);
    const body = JSON.stringify(payload);
    const req = https.request({
      protocol: requestUrl.protocol,
      hostname: requestUrl.hostname,
      port: requestUrl.port || undefined,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        ...headers
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = raw;
        if (raw) {
          try {
            parsed = JSON.parse(raw);
          } catch (_err) {}
        }
        if ((res.statusCode || 500) >= 200 && (res.statusCode || 500) < 300) {
          resolve(parsed);
          return;
        }
        const detail = typeof parsed === 'string'
          ? parsed
          : (parsed && parsed.error && parsed.error.message) || 'Bilinmeyen hata';
        reject(new Error(`HTTP ${res.statusCode || 500}: ${detail}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildAppointmentTemplateParameters(appointment) {
  return [
    { type: 'text', text: appointment.name },
    { type: 'text', text: appointment.service },
    { type: 'text', text: formatAppointmentDateTR(appointment.date) },
    { type: 'text', text: appointment.time },
    { type: 'text', text: appointment.master },
    { type: 'text', text: appointment.phone }
  ];
}

async function sendAppointmentWhatsAppNotification(appointment) {
  const cfg = getWhatsAppConfig();
  if (!cfg || !cfg.notifyTo) return { skipped: true };

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cfg.notifyTo,
    type: 'template',
    template: {
      name: cfg.templateName,
      language: { code: cfg.templateLang },
      components: [
        {
          type: 'body',
          parameters: buildAppointmentTemplateParameters(appointment)
        }
      ]
    }
  };

  return postJson(
    `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`,
    payload,
    { Authorization: `Bearer ${cfg.accessToken}` }
  );
}

function normalizeMasterName(master) {
  const raw = cleanString(master);
  const value = raw.toLowerCase('tr-TR');
  if (!value) return '';
  const compact = value
    .replaceAll('ş', 's')
    .replaceAll('ı', 'i')
    .replaceAll('ğ', 'g')
    .replaceAll('ü', 'u')
    .replaceAll('ö', 'o')
    .replaceAll('ç', 'c')
    .replace(/[^a-z0-9]/g, '');
  if (compact === 'serifkuray' || compact === 'serif' || compact.endsWith('erif')) return 'Şerif Kuray';
  if (compact === 'usta1' || compact === 'usta01' || compact === 'muratbulut') return 'Murat Bulut';
  if (compact === 'usta2' || compact === 'usta3' || compact === 'usta02' || compact === 'omercafoglu') return 'Ömer Cafoğlu';
  return cleanString(master);
}

function isActiveAppointment(status) {
  return status === 'pending' || status === 'approved';
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidTime(value) {
  return /^\d{2}:\d{2}$/.test(value);
}

function validateAppointmentInput(body) {
  const item = {
    name: cleanString(body.name),
    phone: cleanString(body.phone),
    email: cleanString(body.email),
    master: normalizeMasterName(body.master),
    service: cleanString(body.service),
    date: cleanString(body.date),
    time: cleanString(body.time),
    note: cleanString(body.note)
  };

  if (!item.name || !item.phone || !item.master || !item.service || !item.date || !item.time) {
    return { ok: false, message: 'Zorunlu alanlar eksik.' };
  }
  if (!MASTER_NAMES.includes(item.master)) {
    return { ok: false, message: 'Gecersiz usta secimi.' };
  }
  if (!isValidDate(item.date) || !isValidTime(item.time)) {
    return { ok: false, message: 'Tarih veya saat formati gecersiz.' };
  }
  if (item.name.length > 120 || item.phone.length > 40 || item.email.length > 160 || item.master.length > 80 || item.service.length > 120 || item.note.length > 1200) {
    return { ok: false, message: 'Alan uzunluklari gecerli degil.' };
  }
  return { ok: true, item };
}

function hasSlotConflict(list, master, date, time, skipId = '') {
  return list.some(item =>
    item.id !== skipId &&
    normalizeMasterName(item.master) === master &&
    item.date === date &&
    item.time === time &&
    isActiveAppointment(item.status)
  );
}

function broadcastEvent(eventName, payload) {
  const chunk = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of eventClients) {
    try {
      client.res.write(chunk);
    } catch (_err) {
      clearInterval(client.keepAliveTimer);
      eventClients.delete(client);
    }
  }
}

function openSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });
  res.write(': connected\n\n');

  const keepAliveTimer = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_err) {}
  }, 25000);

  const client = { res, keepAliveTimer };
  eventClients.add(client);
  req.on('close', () => {
    clearInterval(keepAliveTimer);
    eventClients.delete(client);
  });
}

function safeFilePathFromUrl(urlPathname) {
  const decoded = decodeURIComponent(urlPathname);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
const fullPath = path.join(ROOT_DIR, normalized.replace(/^\/+/, ''));
  if (!fullPath.startsWith(ROOT_DIR)) return null;
  return fullPath;
}

async function serveStatic(req, res, pathname) {
  const cleanPath = normalizePathname(pathname);
  const appRoutes = new Set(['/', '/admin', '/tarihce', '/hizmetler', '/randevu', '/iletisim']);

  if (appRoutes.has(cleanPath) || cleanPath === '/index.html') {
    const html = await fsp.readFile(path.join(ROOT_DIR, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  const filePath = safeFilePathFromUrl(cleanPath);
  if (!filePath || !fs.existsSync(filePath)) {
    sendText(res, 404, 'Sayfa bulunamadi.');
    return;
  }

  const stat = await fsp.stat(filePath);
  if (stat.isDirectory()) {
    sendText(res, 404, 'Sayfa bulunamadi.');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
}

async function handleApi(req, res, pathname) {
  const method = req.method || 'GET';
  const cleanPath = normalizePathname(pathname);

  if (cleanPath === '/api/admin/login' && method === 'POST') {
    let body;
    try {
      body = await readBodyJSON(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    const email = normalizeEmail(body.email);
    const password = cleanString(body.password);
    const admin = await readAdmin();
    if (!email || !password || email !== admin.email || !verifyPassword(password, admin.passwordSalt, admin.passwordHash)) {
      sendJson(res, 401, { error: 'E-posta veya sifre hatali.' });
      return;
    }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    setAuthCookie(res, token);
    sendJson(res, 200, { ok: true, email: admin.email });
    return;
  }

  if (cleanPath === '/api/admin/logout' && method === 'POST') {
    const token = getAuthToken(req);
    if (token) sessions.delete(token);
    clearAuthCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (cleanPath === '/api/admin/me' && method === 'GET') {
    if (!isAdminAuthenticated(req)) {
      sendJson(res, 401, { authenticated: false });
      return;
    }
    const admin = await readAdmin();
    sendJson(res, 200, { authenticated: true, email: admin.email });
    return;
  }

  if (cleanPath === '/api/admin/push/config' && method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const cfg = getWebPushConfig();
    sendJson(res, 200, {
      enabled: !!cfg,
      publicKey: cfg?.publicKey || '',
      subject: cfg?.subject || ''
    });
    return;
  }

  if (cleanPath === '/api/admin/push/subscribe' && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    if (!getWebPushConfig()) {
      sendJson(res, 503, { error: 'Web push ayarlari eksik.' });
      return;
    }
    let body;
    try {
      body = await readBodyJSON(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    try {
      const saved = await savePushSubscription(body.subscription);
      sendJson(res, 200, { ok: true, endpoint: saved.endpoint });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (cleanPath === '/api/admin/push/unsubscribe' && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body;
    try {
      body = await readBodyJSON(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    const subscription = normalizePushSubscription(body.subscription || {});
    const endpoint = subscription?.endpoint || cleanString(body.endpoint);
    const removed = await removePushSubscriptionByEndpoint(endpoint);
    sendJson(res, 200, { ok: true, removed });
    return;
  }

  if (cleanPath === '/api/admin/forgot-password' && method === 'POST') {
    let body;
    try {
      body = await readBodyJSON(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    const email = normalizeEmail(body.email);
    const admin = await readAdmin();
    if (!email || email !== admin.email) {
      sendJson(res, 200, { ok: true, message: 'Eger e-posta kayitliysa sifre sifirlama baglantisi gonderilir.' });
      return;
    }
    const token = crypto.randomBytes(32).toString('hex');
    const resetLink = `${APP_BASE_URL}/admin?reset_token=${encodeURIComponent(token)}`;
    try {
      await sendResetMail(admin.email, resetLink);
    } catch (err) {
      sendJson(res, 500, { error: `Sifre sifirlama maili gonderilemedi. ${err.message}` });
      return;
    }
    admin.resetTokenHash = hashText(token);
    admin.resetExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    admin.updatedAt = new Date().toISOString();
    await writeAdmin(admin);
    sendJson(res, 200, { ok: true, message: 'Sifre sifirlama baglantisi e-postaya gonderildi.' });
    return;
  }

  if (cleanPath === '/api/admin/reset-password' && method === 'POST') {
    let body;
    try {
      body = await readBodyJSON(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    const token = cleanString(body.token);
    const newPassword = cleanString(body.newPassword);
    if (!token || !newPassword) {
      sendJson(res, 400, { error: 'Token ve yeni sifre gerekli.' });
      return;
    }
    if (newPassword.length < 8) {
      sendJson(res, 400, { error: 'Yeni sifre en az 8 karakter olmali.' });
      return;
    }

    const admin = await readAdmin();
    const now = Date.now();
    const expiresAt = admin.resetExpiresAt ? new Date(admin.resetExpiresAt).getTime() : 0;
    if (!admin.resetTokenHash || !expiresAt || Number.isNaN(expiresAt) || expiresAt < now) {
      sendJson(res, 400, { error: 'Sifirlama baglantisi gecersiz veya suresi dolmus.' });
      return;
    }
    if (hashText(token) !== admin.resetTokenHash) {
      sendJson(res, 400, { error: 'Sifirlama baglantisi gecersiz veya suresi dolmus.' });
      return;
    }

    const salt = crypto.randomBytes(16).toString('hex');
    admin.passwordSalt = salt;
    admin.passwordHash = createPasswordHash(newPassword, salt);
    admin.resetTokenHash = null;
    admin.resetExpiresAt = null;
    admin.updatedAt = new Date().toISOString();
    await writeAdmin(admin);
    sendJson(res, 200, { ok: true, message: 'Sifre basariyla guncellendi.' });
    return;
  }

  if (cleanPath === '/api/admin/events' && method === 'GET') {
    if (!requireAdmin(req, res)) return;
    openSSE(req, res);
    return;
  }

  if (cleanPath === '/api/appointments' && method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const list = await readAppointments();
    sendJson(res, 200, { items: list });
    return;
  }

  if (cleanPath === '/api/appointments/availability' && method === 'GET') {
    const requestURL = new URL(req.url || '/', `http://${req.headers.host || `localhost:${PORT}`}`);
    const master = normalizeMasterName(requestURL.searchParams.get('master') || '');
    const date = cleanString(requestURL.searchParams.get('date') || '');
    if (!MASTER_NAMES.includes(master) || !isValidDate(date)) {
      sendJson(res, 200, { master, date, bookedTimes: [] });
      return;
    }
    const list = await readAppointments();
    const bookedTimes = list
      .filter(item =>
        normalizeMasterName(item.master) === master &&
        item.date === date &&
        isActiveAppointment(item.status)
      )
      .map(item => item.time)
      .sort();
    sendJson(res, 200, { master, date, bookedTimes });
    return;
  }

  if (cleanPath === '/api/appointments' && method === 'POST') {
    let body;
    try {
      body = await readBodyJSON(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    const check = validateAppointmentInput(body);
    if (!check.ok) {
      sendJson(res, 400, { error: check.message });
      return;
    }

    const appointment = {
      id: crypto.randomUUID(),
      ...check.item,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: null
    };
    const list = await readAppointments();
    if (hasSlotConflict(list, appointment.master, appointment.date, appointment.time)) {
      sendJson(res, 409, { error: 'Secilen usta icin bu tarih ve saat dolu.' });
      return;
    }
    list.push(appointment);
    await writeAppointments(list);
    try {
      await sendAppointmentWhatsAppNotification(appointment);
    } catch (err) {
      console.error('[whatsapp] Randevu bildirimi gonderilemedi:', err.message);
    }
    try {
      await sendAppointmentPushNotifications(appointment);
    } catch (err) {
      console.error('[push] Randevu bildirimi gonderilemedi:', err.message);
    }
    broadcastEvent('appointment_created', {
      id: appointment.id,
      name: appointment.name,
      createdAt: appointment.createdAt
    });
    sendJson(res, 201, { ok: true, item: appointment });
    return;
  }

  if (cleanPath.startsWith('/api/appointments/') && cleanPath.endsWith('/status') && method === 'PATCH') {
    if (!requireAdmin(req, res)) return;
    let body;
    try {
      body = await readBodyJSON(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    const status = cleanString(body.status);
    if (!['approved', 'cancelled'].includes(status)) {
      sendJson(res, 400, { error: 'Gecersiz durum.' });
      return;
    }

    const parts = cleanPath.split('/');
    const appointmentId = parts[3] || '';
    if (!appointmentId) {
      sendJson(res, 400, { error: 'Randevu ID gerekli.' });
      return;
    }

    const list = await readAppointments();
    const idx = list.findIndex(item => item.id === appointmentId);
    if (idx < 0) {
      sendJson(res, 404, { error: 'Randevu bulunamadi.' });
      return;
    }
    if (status === 'approved' && hasSlotConflict(list, normalizeMasterName(list[idx].master), list[idx].date, list[idx].time, appointmentId)) {
      sendJson(res, 409, { error: 'Bu saatte aktif baska bir randevu var.' });
      return;
    }
    if (status === 'cancelled') {
      const deletedItem = list.splice(idx, 1)[0];
      await writeAppointments(list);
      broadcastEvent('appointment_status', { id: appointmentId, status: 'cancelled', deleted: true });
      sendJson(res, 200, { ok: true, deleted: true, item: deletedItem });
      return;
    }
    list[idx].status = status;
    list[idx].updatedAt = new Date().toISOString();
    await writeAppointments(list);
    broadcastEvent('appointment_status', { id: appointmentId, status });
    sendJson(res, 200, { ok: true, item: list[idx] });
    return;
  }

  sendJson(res, 404, { error: 'API endpoint bulunamadi.' });
}

const server = http.createServer(async (req, res) => {
  try {
    const requestURL = new URL(req.url || '/', `http://${req.headers.host || `localhost:${PORT}`}`);
    const pathname = requestURL.pathname;
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }
    await serveStatic(req, res, pathname);
  } catch (err) {
    sendJson(res, 500, { error: 'Sunucu hatasi.', detail: err.message });
  }
});

server.listen(PORT, async () => {
  await ensureDataFiles();
  console.log(`Server running on http://localhost:${PORT}`);
});



