/**
 * TikTok Services Control Center — Express + SQLite Server
 */

import express, { Request, Response, NextFunction } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import {
  cents,
  money,
  targetValid,
  calculateQuote,
  isOrderTransitionValid,
  isBroadcastTransitionValid,
} from './src/domain/logic';
import {
  startTelegramWorker,
  callTelegram,
  botRuntimeState,
} from './src/telegram/poller';

const app = express();
const PORT = 3000;

// Directories
const DATA_DIR = path.resolve('data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const STATIC_DIR = path.resolve('static');

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(UPLOADS_DIR, { recursive: true, mode: 0o700 });

// Database initialization
const dbPath = path.join(DATA_DIR, 'system.sqlite3');
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS workflows(id INTEGER PRIMARY KEY, name TEXT NOT NULL, steps TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL, updated TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS flow_runs(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), workflow_id INTEGER NOT NULL REFERENCES workflows(id), revision INTEGER NOT NULL DEFAULT 1, step INTEGER NOT NULL DEFAULT 0, variables TEXT NOT NULL, status TEXT NOT NULL, updated TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS topup_drafts(user_id INTEGER PRIMARY KEY REFERENCES users(id), state TEXT NOT NULL, data TEXT NOT NULL, updated TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS button_context(code TEXT PRIMARY KEY, user_id INTEGER NOT NULL, button_id INTEGER NOT NULL, data TEXT NOT NULL, expires REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS reply_context(user_id INTEGER PRIMARY KEY, buttons TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS locales(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS translations(id INTEGER PRIMARY KEY, locale TEXT NOT NULL REFERENCES locales(code), token TEXT NOT NULL, text TEXT NOT NULL, UNIQUE(locale,token));
  CREATE TABLE IF NOT EXISTS assets(id INTEGER PRIMARY KEY, name TEXT NOT NULL, stored_name TEXT UNIQUE NOT NULL, mime TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, purpose TEXT NOT NULL, actor TEXT NOT NULL, created TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('expense','fee')), amount INTEGER NOT NULL CHECK(amount!=0), reason TEXT NOT NULL, occurred_on TEXT NOT NULL, actor TEXT NOT NULL, operation_key TEXT UNIQUE NOT NULL, reversed_from INTEGER UNIQUE REFERENCES expenses(id), created TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS expenses_no_update BEFORE UPDATE ON expenses BEGIN SELECT RAISE(ABORT,'immutable expense'); END;
  CREATE TRIGGER IF NOT EXISTS expenses_no_delete BEFORE DELETE ON expenses BEGIN SELECT RAISE(ABORT,'immutable expense'); END;
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS staff(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', telegram_id INTEGER UNIQUE, permissions TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL, last_active TEXT, auth_version INTEGER NOT NULL DEFAULT 0, added_by TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0), status TEXT NOT NULL DEFAULT 'active', note TEXT NOT NULL DEFAULT '', created TEXT NOT NULL, last_active TEXT, language TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS services(id INTEGER PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>=0), cost INTEGER NOT NULL DEFAULT 0, min_qty INTEGER NOT NULL DEFAULT 100, max_qty INTEGER NOT NULL DEFAULT 100000, description TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '', target_type TEXT NOT NULL DEFAULT 'any', enabled INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), service_id INTEGER NOT NULL REFERENCES services(id), service_name TEXT NOT NULL, target TEXT NOT NULL, quantity INTEGER NOT NULL, price INTEGER NOT NULL, cost INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', note TEXT NOT NULL DEFAULT '', request_key TEXT UNIQUE NOT NULL, refunded INTEGER NOT NULL DEFAULT 0, debit_id INTEGER, refund_id INTEGER, created TEXT NOT NULL, updated TEXT NOT NULL, completed TEXT);
  CREATE TABLE IF NOT EXISTS topups(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), amount INTEGER NOT NULL CHECK(amount>0), method TEXT NOT NULL, status TEXT NOT NULL, proof TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', payload TEXT UNIQUE, stars INTEGER, created TEXT NOT NULL, updated TEXT NOT NULL, checkout_started INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, charge_id TEXT UNIQUE NOT NULL, topup_id INTEGER UNIQUE NOT NULL REFERENCES topups(id), user_id INTEGER NOT NULL REFERENCES users(id), amount INTEGER NOT NULL, currency TEXT NOT NULL, created TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), delta INTEGER NOT NULL, before_balance INTEGER NOT NULL, after_balance INTEGER NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL, operation_key TEXT UNIQUE NOT NULL, order_id INTEGER, payment_id INTEGER, created TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'adjustment', status TEXT NOT NULL DEFAULT 'posted');
  CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
  CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
  CREATE TABLE IF NOT EXISTS inventory(id INTEGER PRIMARY KEY, username TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'available', deleted INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, updated TEXT NOT NULL, added_by TEXT NOT NULL, updated_by TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', order_id INTEGER REFERENCES orders(id), created TEXT NOT NULL, updated TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id), actor TEXT NOT NULL, body TEXT NOT NULL, attachment TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS menus(id INTEGER PRIMARY KEY, name TEXT NOT NULL, key TEXT UNIQUE NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'inline', layout_key TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS buttons(id INTEGER PRIMARY KEY, menu_id INTEGER NOT NULL REFERENCES menus(id), label TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'callback', action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', row_num INTEGER NOT NULL DEFAULT 0, col_num INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, permission TEXT NOT NULL DEFAULT '', child_menu TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS sessions(user_id INTEGER PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL, updated REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS drafts(user_id INTEGER PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'immutable audit'); END;
  CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'immutable audit'); END;
  CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS broadcasts(id INTEGER PRIMARY KEY, body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', media TEXT NOT NULL DEFAULT '', audience TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', created TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS deliveries(id INTEGER PRIMARY KEY, broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id), user_id INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'pending', error TEXT NOT NULL DEFAULT '', UNIQUE(broadcast_id,user_id));
  CREATE TABLE IF NOT EXISTS updates(id INTEGER PRIMARY KEY, created TEXT NOT NULL);
`);

// Helpers
function now(): string {
  return new Date().toISOString();
}

function getSetting(key: string, defaultValue: any = null): any {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : defaultValue;
}

function putSetting(key: string, value: any): void {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(
    key,
    JSON.stringify(value)
  );
}

function audit(actor: any, action: string, entity: any, data: any): void {
  db.prepare('INSERT INTO audit(actor, action, entity, data, created) VALUES(?, ?, ?, ?, ?)').run(
    String(actor),
    action,
    String(entity),
    JSON.stringify(data),
    now()
  );
}

// Seed default settings, menus, services
(function seedInitialData() {
  db.prepare("INSERT OR IGNORE INTO locales(code, name) VALUES('ar', 'العربية')").run();

  const defaults: Record<string, any> = {
    web_url: '',
    support_enabled: true,
    customer_cancel_pending: true,
    brand: 'TikTok Services',
    maintenance: 'off',
    maintenance_staff: true,
    manual_enabled: true,
    stars_enabled: true,
    topup_min: 100,
    topup_max: 100000,
    stars_rate: 100,
    transfer_instructions: 'يرجى التواصل مع الدعم للحصول على بيانات التحويل قبل الدفع.',
    order_min: 1,
    order_max: 10000000,
    expenses: 0,
    fees: 0,
    session_minutes: 30,
    owner_telegram_id: 0,
    language: 'ar',
    notifications_enabled: true,
  };

  for (const [k, v] of Object.entries(defaults)) {
    if (!db.prepare('SELECT 1 FROM settings WHERE key=?').get(k)) {
      putSetting(k, v);
    }
  }

  // Seed services
  const svcCount = db.prepare('SELECT COUNT(*) as c FROM services').get() as { c: number };
  if (svcCount.c === 0) {
    const defaultServices = [
      ['👥 متابعو تيك توك', 100, 40, 100, 50000, 'any'],
      ['👁 مشاهدات تيك توك', 50, 20, 500, 100000, 'video'],
      ['❤️ إعجابات تيك توك', 75, 30, 100, 25000, 'video'],
    ];
    defaultServices.forEach(([name, price, cost, min_qty, max_qty, target_type], i) => {
      db.prepare(
        'INSERT INTO services(name, price, cost, min_qty, max_qty, target_type, position) VALUES(?, ?, ?, ?, ?, ?, ?)'
      ).run(name, price, cost, min_qty, max_qty, target_type, i);
    });
  }

  // Seed menus & buttons
  const menuCount = db.prepare('SELECT COUNT(*) as c FROM menus').get() as { c: number };
  if (menuCount.c === 0) {
    const menus = [
      ['home', 'القائمة الرئيسية', '🎵 أهلاً بك في TikTok Services Bot\n\nمرحباً بك في عالم خدمات تيك توك.\n🛒 طلب الخدمات\n💳 شحن رصيدك\n📋 متابعة طلباتك\n👤 إدارة حسابك\n🎧 التواصل مع الدعم الفني\n\nاختر ما تريد من القائمة أدناه.', 'inline'],
      ['services', 'الخدمات', '🛒 قائمة الخدمات\nاختر الخدمة التي تريد طلبها. الأسعار محسوبة حسب الكمية.', 'inline'],
      ['topup', 'شحن الرصيد', '💳 اختر طريقة الشحن المناسبة لك.', 'inline'],
      ['account', 'الحساب', '👤 حسابك الشخصي', 'inline'],
      ['myorders', 'الطلبات', '📋 طلباتك', 'inline'],
      ['support', 'الدعم', '🎧 كيف يمكننا مساعدتك؟', 'inline'],
      ['maintenance', 'الصيانة', '🛠 البوت تحت الصيانة حاليًا. يرجى المحاولة لاحقًا.', 'text'],
      ['error', 'خطأ', '❌ البيانات المدخلة غير صحيحة. يرجى المحاولة مرة أخرى.', 'text'],
      ['expired', 'انتهاء الجلسة', '⌛ انتهت جلسة الاستخدام. يرجى بدء العملية من جديد.', 'text'],
    ];

    for (const [key, name, text, kind] of menus) {
      db.prepare('INSERT INTO menus(key, name, text, kind) VALUES(?, ?, ?, ?)').run(key, name, text, kind);
    }

    const homeRow = db.prepare("SELECT id FROM menus WHERE key='home'").get() as { id: number };
    if (homeRow) {
      const homeButtons = [
        ['🛒 الخدمات', 'services'],
        ['💳 شحن الرصيد', 'topup'],
        ['📋 طلباتي', 'myorders'],
        ['👤 حسابي', 'account'],
        ['🎧 الدعم الفني', 'support'],
      ];
      homeButtons.forEach(([label, action], i) => {
        db.prepare(
          'INSERT INTO buttons(menu_id, label, action, row_num, col_num) VALUES(?, ?, ?, ?, ?)'
        ).run(homeRow.id, label, action, Math.floor(i / 2), i % 2);
      });
    }
  }
})();

// Start Telegram Background Worker
startTelegramWorker(db);

// Permissions & Schemas constants
const PERMISSIONS = [
  'stats',
  'expenses',
  'orders',
  'topups',
  'topups_approve',
  'users',
  'users_manage',
  'balances',
  'services',
  'inventory',
  'support',
  'broadcasts',
  'settings',
  'menus',
  'staff',
  'ledger',
  'audit',
];

const SCHEMAS: Record<string, Record<string, string>> = {
  services: {
    name: 'text',
    price: 'money',
    cost: 'money',
    min_qty: 'int',
    max_qty: 'int',
    description: 'text',
    image: 'text',
    target_type: 'any|profile|video',
    enabled: 'bool',
    position: 'int',
  },
  inventory: {
    username: 'text',
    note: 'text',
    status: 'available|reserved|used|unavailable',
  },
  menus: {
    name: 'text',
    key: 'text',
    text: 'text',
    kind: 'inline|reply|text|multilevel',
    layout_key: 'text',
  },
  buttons: {
    menu_id: 'int',
    label: 'text',
    kind: 'callback|reply|url|webapp',
    action:
      'callback|services|topup|myorders|account|support|menu|message|order|ledger|tickets|topups|admin|workflow|language|none',
    target: 'text',
    row_num: 'int',
    col_num: 'int',
    enabled: 'bool',
    permission: 'text',
    child_menu: 'text',
  },
  locales: { code: 'text', name: 'text', enabled: 'bool' },
  translations: { locale: 'text', token: 'text', text: 'text' },
  broadcasts: {
    body: 'text',
    kind: 'text|photo|video|document',
    media: 'text',
    audience: 'all|active|balance|orders',
  },
};

const TABLE_PERM: Record<string, string> = {
  workflows: 'menus',
  flow_runs: 'menus',
  translations: 'menus',
  locales: 'settings',
  expenses: 'expenses',
  assets: 'audit',
  deliveries: 'broadcasts',
  tickets: 'support',
  messages: 'support',
  payments: 'ledger',
  notifications: 'audit',
  buttons: 'menus',
  services: 'services',
  inventory: 'inventory',
  staff: 'staff',
  menus: 'menus',
  orders: 'orders',
  topups: 'topups',
  users: 'users',
  balances: 'balances',
  ledger: 'ledger',
  audit: 'audit',
  broadcasts: 'broadcasts',
  settings: 'settings',
};

// Session Management using signed cookie persisted across restarts
const KEY_FILE = path.join(DATA_DIR, 'session.key');
let SESSION_SECRET: string;
if (fs.existsSync(KEY_FILE)) {
  SESSION_SECRET = fs.readFileSync(KEY_FILE, 'utf8').trim();
} else {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(KEY_FILE, SESSION_SECRET, { mode: 0o600 });
}

interface SessionData {
  uid?: number;
  auth_version?: number;
  csrf?: string;
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  const list: Record<string, string> = {};
  if (!header) return list;
  header.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    const name = parts.shift()?.trim();
    if (name) list[name] = decodeURIComponent(parts.join('='));
  });
  return list;
}

const tokenSessions = new Map<string, SessionData>();

function saveSessionCookie(res: Response, session: SessionData) {
  if (session.csrf) {
    tokenSessions.set(session.csrf, session);
  }
  const payload = Buffer.from(JSON.stringify(session)).toString('base64');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  res.cookie('session', `${payload}.${sig}`, {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    path: '/',
  });
}

function getSession(req: Request, res: Response): SessionData {
  const csrfHeader = (req.headers['x-csrf-token'] as string) || '';
  if (csrfHeader && tokenSessions.has(csrfHeader)) {
    return tokenSessions.get(csrfHeader)!;
  }

  const cookies = parseCookies(req);
  let sessionData: SessionData | null = null;
  if (cookies.session) {
    try {
      const [payload, sig] = cookies.session.split('.');
      const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
      if (sig === expectedSig) {
        sessionData = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
      }
    } catch {}
  }

  if (sessionData && sessionData.csrf && tokenSessions.has(sessionData.csrf)) {
    return tokenSessions.get(sessionData.csrf)!;
  }

  if (!sessionData) {
    sessionData = {
      csrf: crypto.randomBytes(16).toString('hex'),
    };
  }

  if (sessionData.csrf) {
    tokenSessions.set(sessionData.csrf, sessionData);
  }
  saveSessionCookie(res, sessionData);

  return sessionData;
}

function cleanStaff(r: any): any {
  if (!r) return null;
  return {
    id: r.id,
    username: r.username,
    role: r.role,
    telegram_id: r.telegram_id,
    permissions: typeof r.permissions === 'string' ? JSON.parse(r.permissions || '[]') : r.permissions,
    created: r.created,
    last_active: r.last_active,
  };
}

function allowed(actor: any, perm: string): boolean {
  if (!actor) return false;
  if (actor.role === 'owner') return true;
  const p = actor.permissions || [];
  return Array.isArray(p) && p.includes(perm);
}

// Multer storage for uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const stored = crypto.randomBytes(24).toString('hex') + ext;
    cb(null, stored);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
});

// Middleware
app.set('trust proxy', true);
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    return res.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// CSRF Protection Middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const session = getSession(req, res);
    const csrfHeader = req.headers['x-csrf-token'];
    if (!session.csrf || session.csrf !== csrfHeader) {
      return res.status(403).json({ error: 'انتهت جلسة الأمان. حدّث الصفحة.' });
    }
  }
  next();
});

// Helper auth middleware
function requireAuth(perm?: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const session = getSession(req, res);
    if (!session.uid) {
      return res.status(401).json({ error: 'يرجى تسجيل الدخول' });
    }
    const staffRow = db.prepare('SELECT * FROM staff WHERE id=? AND enabled=1').get(session.uid) as any;
    if (!staffRow || staffRow.auth_version !== (session.auth_version ?? 0)) {
      return res.status(401).json({ error: 'انتهت صلاحية الجلسة' });
    }
    const actor = cleanStaff(staffRow);
    if (perm && !allowed(actor, perm)) {
      return res.status(403).json({ error: 'غير مصرح' });
    }
    (req as any).actor = actor;
    next();
  };
}

// --- API ROUTES ---

// 1. Session / Identity
app.get('/api/session', (req: Request, res: Response) => {
  const session = getSession(req, res);
  const countRow = db.prepare('SELECT COUNT(*) as c FROM staff').get() as { c: number };
  let actor: any = null;

  if (session.uid) {
    const a = db.prepare('SELECT * FROM staff WHERE id=? AND enabled=1').get(session.uid) as any;
    if (a && a.auth_version === (session.auth_version ?? 0)) {
      actor = cleanStaff(a);
    }
  }

  res.json({
    csrf: session.csrf,
    setup: countRow.c === 0,
    actor,
  });
});

// 2. Auth: setup, login, logout
const loginRateLimit = new Map<string, number[]>();

app.post('/api/auth/:action', async (req: Request, res: Response) => {
  const action = req.params.action;
  const ip = req.ip || '127.0.0.1';
  const nowMs = Date.now();

  const attempts = (loginRateLimit.get(ip) || []).filter((t) => t > nowMs - 300000);
  if (attempts.length >= 10) {
    return res.status(429).json({ error: 'محاولات كثيرة. انتظر خمس دقائق.' });
  }
  attempts.push(nowMs);
  loginRateLimit.set(ip, attempts);

  const session = getSession(req, res);
  const body = req.body || {};

  try {
    if (action === 'setup') {
      const existingOwner = db.prepare("SELECT 1 FROM staff WHERE role='owner'").get();
      if (existingOwner) {
        return res.status(400).json({ error: 'تم إعداد المالك مسبقًا' });
      }

      const username = (body.username || '').trim();
      const password = body.password || '';

      if (!username || password.length < 12) {
        return res.status(400).json({ error: 'اختر اسم دخول وكلمة مرور لا تقل عن 12 حرفًا' });
      }

      const hash = await bcrypt.hash(password, 10);
      const insert = db.prepare(
        "INSERT INTO staff(username, password, role, permissions, created) VALUES(?, ?, 'owner', ?, ?)"
      ).run(username, hash, JSON.stringify(PERMISSIONS), now());

      const uid = Number(insert.lastInsertRowid);
      audit(uid, 'owner.setup', uid, {});

      session.uid = uid;
      session.auth_version = 0;
      session.csrf = crypto.randomBytes(16).toString('hex');
      saveSessionCookie(res, session);
      return res.json({ ok: true, csrf: session.csrf });
    }

    if (action === 'login') {
      const username = (body.username || '').trim();
      const password = body.password || '';

      const staff = db.prepare('SELECT * FROM staff WHERE username=? AND enabled=1').get(username) as any;
      if (!staff || !(await bcrypt.compare(password, staff.password))) {
        return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
      }

      db.prepare('UPDATE staff SET last_active=? WHERE id=?').run(now(), staff.id);
      session.uid = staff.id;
      session.auth_version = staff.auth_version || 0;
      session.csrf = crypto.randomBytes(16).toString('hex');
      saveSessionCookie(res, session);
      return res.json({ ok: true, csrf: session.csrf });
    }

    if (action === 'logout') {
      session.uid = undefined;
      session.auth_version = undefined;
      session.csrf = crypto.randomBytes(16).toString('hex');
      saveSessionCookie(res, session);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'عملية غير صالحة' });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'خطأ في المصادقة' });
  }
});

// 3. Password change
app.post('/api/password', requireAuth(), async (req: Request, res: Response) => {
  const actor = (req as any).actor;
  const { current, new: newPass } = req.body || {};

  const staff = db.prepare('SELECT * FROM staff WHERE id=?').get(actor.id) as any;
  if (!staff || !(await bcrypt.compare(current, staff.password))) {
    return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
  }

  if (!newPass || newPass.length < 12) {
    return res.status(400).json({ error: 'كلمة المرور الجديدة لا تقل عن 12 حرفًا' });
  }

  const hash = await bcrypt.hash(newPass, 10);
  const newAuthVersion = (staff.auth_version || 0) + 1;
  db.prepare('UPDATE staff SET password=?, auth_version=? WHERE id=?').run(hash, newAuthVersion, actor.id);

  const session = getSession(req, res);
  session.auth_version = newAuthVersion;

  audit(actor.id, 'staff.password_changed', actor.id, {});
  res.json({ ok: true });
});

// 4. Media upload & download
app.post('/api/media', requireAuth(), upload.single('file'), (req: Request, res: Response) => {
  const actor = (req as any).actor;
  const purpose = req.body.purpose || 'services';

  if (!['services', 'broadcasts', 'support'].includes(purpose) || !allowed(actor, purpose)) {
    return res.status(403).json({ error: 'لا تملك صلاحية رفع ملفات لهذا القسم' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'اختر ملفًا للرفع' });
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  const kind = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)
    ? 'photo'
    : ext === '.mp4'
    ? 'video'
    : 'document';
  const mime = req.file.mimetype || 'application/octet-stream';

  const insert = db.prepare(
    'INSERT INTO assets(name, stored_name, mime, kind, size, purpose, actor, created) VALUES(?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(req.file.originalname, req.file.filename, mime, kind, req.file.size, purpose, String(actor.id), now());

  const aid = Number(insert.lastInsertRowid);
  audit(actor.id, 'media.upload', aid, { name: req.file.originalname, kind, purpose });

  res.json({
    id: aid,
    ref: `upload:${aid}`,
    kind,
    name: req.file.originalname,
    size: req.file.size,
    url: `/api/media/${aid}`,
  });
});

app.get('/api/media/:aid', requireAuth(), (req: Request, res: Response) => {
  const aid = Number(req.params.aid);
  const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(aid) as any;
  if (!asset) {
    return res.status(404).json({ error: 'الملف غير موجود' });
  }

  const filePath = path.join(UPLOADS_DIR, asset.stored_name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'الملف غير موجود على الخادم' });
  }

  res.setHeader('Content-Type', asset.mime);
  if (asset.kind !== 'photo') {
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(asset.name)}"`);
  }
  fs.createReadStream(filePath).pipe(res);
});

// 5. Proof file
app.get('/api/topups/:tid/proof', requireAuth('topups'), (req: Request, res: Response) => {
  const tid = Number(req.params.tid);
  const topup = db.prepare('SELECT * FROM topups WHERE id=?').get(tid) as any;
  if (!topup || !topup.proof) {
    return res.status(404).json({ error: 'لم يُرفق إثبات لهذا الطلب' });
  }

  try {
    const proof = JSON.parse(topup.proof);
    return res.json(proof);
  } catch {
    return res.json({ type: 'text', text: topup.proof });
  }
});

// 6. Expenses
app.post('/api/expenses', requireAuth('expenses'), (req: Request, res: Response) => {
  const actor = (req as any).actor;
  const { kind, amount, reason, occurred_on, key } = req.body || {};

  if (!['expense', 'fee'].includes(kind) || !amount || !reason || !occurred_on || !key) {
    return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
  }

  try {
    const centsAmount = cents(amount);
    const existing = db.prepare('SELECT id FROM expenses WHERE operation_key=?').get(key) as any;
    if (existing) {
      return res.json({ ok: true, id: existing.id });
    }

    const insert = db.prepare(
      'INSERT INTO expenses(kind, amount, reason, occurred_on, actor, operation_key, created) VALUES(?, ?, ?, ?, ?, ?, ?)'
    ).run(kind, centsAmount, reason.trim(), occurred_on, String(actor.id), key, now());

    const eid = Number(insert.lastInsertRowid);
    audit(actor.id, 'expense.created', eid, { kind, amount: centsAmount, reason });
    res.json({ ok: true, id: eid });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'خطأ في حفظ المصروف' });
  }
});

app.post('/api/expenses/:eid/reverse', requireAuth('expenses'), (req: Request, res: Response) => {
  const actor = (req as any).actor;
  const eid = Number(req.params.eid);
  const { reason, occurred_on, key } = req.body || {};

  const original = db.prepare('SELECT * FROM expenses WHERE id=?').get(eid) as any;
  if (!original) {
    return res.status(404).json({ error: 'المصروف غير موجود' });
  }

  if (original.reversed_from || original.amount < 0) {
    return res.status(400).json({ error: 'الحركة لا تقبل العكس' });
  }

  const alreadyReversed = db.prepare('SELECT id FROM expenses WHERE reversed_from=?').get(eid);
  if (alreadyReversed) {
    return res.status(400).json({ error: 'تم عكس المصروف مسبقًا' });
  }

  try {
    const insert = db.prepare(
      'INSERT INTO expenses(kind, amount, reason, occurred_on, actor, operation_key, reversed_from, created) VALUES(?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(original.kind, -original.amount, (reason || '').trim(), occurred_on, String(actor.id), key, eid, now());

    const revId = Number(insert.lastInsertRowid);
    audit(actor.id, 'expense.reversed', revId, { original: eid, amount: -original.amount });
    res.json({ ok: true, id: revId });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'خطأ في عكس المصروف' });
  }
});

// 7. Bootstrap
app.get('/api/bootstrap', requireAuth(), (req: Request, res: Response) => {
  const actor = (req as any).actor;

  const settingsRows = db.prepare("SELECT key, value FROM settings WHERE key NOT IN ('telegram_token', 'poll_offset')").all() as any[];
  const settings: Record<string, any> = {};
  for (const r of settingsRows) {
    try {
      settings[r.key] = JSON.parse(r.value);
    } catch {
      settings[r.key] = r.value;
    }
  }

  const connected = Boolean(getSetting('telegram_token'));
  const menus = allowed(actor, 'menus')
    ? db.prepare('SELECT id, key, name, kind, layout_key FROM menus ORDER BY id').all()
    : [];
  const locales = db.prepare('SELECT * FROM locales ORDER BY id').all();
  const services = db.prepare('SELECT id, name FROM services WHERE enabled=1 AND deleted=0 ORDER BY position, id').all();

  res.json({
    actor,
    permissions: PERMISSIONS,
    schemas: SCHEMAS,
    settings: allowed(actor, 'settings') ? settings : { brand: settings.brand },
    connected,
    menus,
    locales,
    services,
    runtime: {
      status: connected ? (botRuntimeState.status || 'connected') : 'disconnected',
      error: botRuntimeState.error || '',
      last_update: botRuntimeState.lastUpdate,
      username: botRuntimeState.botUsername || (getSetting('bot_identity')?.username || ''),
    },
  });
});

// 8. Stats
app.get('/api/stats', requireAuth('stats'), (req: Request, res: Response) => {
  const start = (req.query.start as string) || '';
  const end = (req.query.end as string) || '9999';

  const userCount = (db.prepare('SELECT COUNT(*) as c FROM users WHERE created>=? AND created<=?').get(start, end) as any).c;
  const orderCount = (db.prepare('SELECT COUNT(*) as c FROM orders WHERE created>=? AND created<=?').get(start, end) as any).c;
  const statuses = db.prepare('SELECT status, COUNT(*) as count FROM orders WHERE created>=? AND created<=? GROUP BY status').all(start, end);

  const salesRow = db.prepare(
    'SELECT COALESCE(SUM(price), 0) as s, COALESCE(SUM(cost), 0) as c FROM orders WHERE completed IS NOT NULL AND completed>=? AND completed<=?'
  ).get(start, end) as any;

  const sales = salesRow.s || 0;
  const cost = salesRow.c || 0;

  const refundsRow = db.prepare(
    'SELECT COALESCE(SUM(l.delta), 0) as r FROM ledger l JOIN orders o ON o.refund_id=l.id WHERE l.created>=? AND l.created<=?'
  ).get(start, end) as any;
  const refunds = refundsRow.r || 0;

  const recognizedRefundsRow = db.prepare(
    'SELECT COALESCE(SUM(l.delta), 0) as r FROM ledger l JOIN orders o ON o.refund_id=l.id WHERE o.completed IS NOT NULL AND l.created>=? AND l.created<=?'
  ).get(start, end) as any;
  const recognized_refunds = recognizedRefundsRow.r || 0;

  const net_sales = sales - recognized_refunds;

  const topupsRow = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as t FROM topups WHERE status='approved' AND updated>=? AND updated<=?"
  ).get(start, end) as any;
  const topups = topupsRow.t || 0;

  const expensesRow = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as e FROM expenses WHERE kind='expense' AND occurred_on>=? AND occurred_on<=?"
  ).get(start.slice(0, 10), end.slice(0, 10)) as any;
  const expenses = expensesRow.e || 0;

  const feesRow = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as f FROM expenses WHERE kind='fee' AND occurred_on>=? AND occurred_on<=?"
  ).get(start.slice(0, 10), end.slice(0, 10)) as any;
  const fees = feesRow.f || 0;

  const profit = net_sales - cost - expenses - fees;

  const chart = db.prepare(
    'SELECT substr(created, 1, 10) as day, COUNT(*) as count, SUM(price) as total FROM orders WHERE created>=? AND created<=? GROUP BY day ORDER BY day DESC LIMIT 14'
  ).all(start, end);

  res.json({
    users: userCount,
    orders: orderCount,
    statuses,
    sales,
    cost,
    refunds,
    recognized_refunds,
    net_sales,
    topups,
    expenses,
    fees,
    profit,
    chart,
  });
});

// 9. Data CRUD: GET /api/data/:table
app.get('/api/data/:table', requireAuth(), (req: Request, res: Response) => {
  const actor = (req as any).actor;
  const table = req.params.table;
  const perm = TABLE_PERM[table];

  if (!perm || !allowed(actor, perm)) {
    return res.status(403).json({ error: 'غير مصرح' });
  }

  const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
  const size = 25;

  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((r) => r.name);
  const where: string[] = [];
  const args: any[] = [];

  if (cols.includes('deleted')) {
    where.push('deleted=0');
  }

  const q = ((req.query.q as string) || '').trim();
  if (q) {
    const searchable = cols.filter((k) => !['password', 'payload'].includes(k));
    if (searchable.length > 0) {
      where.push(`(${searchable.map((k) => `CAST(${k} AS TEXT) LIKE ?`).join(' OR ')})`);
      for (let i = 0; i < searchable.length; i++) {
        args.push(`%${q}%`);
      }
    }
  }

  for (const filterCol of ['status', 'user_id', 'ticket_id', 'menu_id', 'order_id', 'entity', 'broadcast_id']) {
    if (cols.includes(filterCol) && req.query[filterCol]) {
      where.push(`${filterCol}=?`);
      args.push(req.query[filterCol]);
    }
  }

  const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const totalRow = db.prepare(`SELECT COUNT(*) as c FROM ${table}` + clause).get(...args) as { c: number };
  const total = totalRow.c;

  let orderBy = 'id DESC';
  if (table === 'menus') {
    orderBy =
      "CASE WHEN key IN ('home','services','topup','account','myorders','support','maintenance','error','expired') THEN 0 WHEN key LIKE 'layout_%' THEN 1 WHEN key LIKE 'label_%' THEN 3 ELSE 2 END, id";
  } else if (table === 'services') {
    orderBy = 'position, id';
  }

  const items = db.prepare(
    `SELECT * FROM ${table}${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
  ).all(...args, size, (page - 1) * size) as any[];

  if (table === 'users') {
    for (const u of items) {
      u.order_count = (db.prepare('SELECT COUNT(*) as c FROM orders WHERE user_id=?').get(u.id) as any).c;
      u.completed_orders = (db.prepare("SELECT COUNT(*) as c FROM orders WHERE user_id=? AND status='completed'").get(u.id) as any).c;
      u.pending_orders = (db.prepare("SELECT COUNT(*) as c FROM orders WHERE user_id=? AND status='pending'").get(u.id) as any).c;
      u.total_topups = (db.prepare("SELECT COALESCE(SUM(amount), 0) as s FROM topups WHERE user_id=? AND status='approved'").get(u.id) as any).s;
    }
  } else if (table === 'staff') {
    for (let i = 0; i < items.length; i++) {
      items[i] = cleanStaff(items[i]);
    }
  } else if (table === 'broadcasts') {
    for (const b of items) {
      b.report = db.prepare('SELECT status, COUNT(*) as count FROM deliveries WHERE broadcast_id=? GROUP BY status').all(b.id);
    }
  }

  res.json({
    items,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / size)),
  });
});

// 10. Data CRUD: POST /api/data/:table (Create or Update)
app.post('/api/data/:table', requireAuth(), async (req: Request, res: Response) => {
  const actor = (req as any).actor;
  const table = req.params.table;
  const perm = TABLE_PERM[table];

  if (!perm || !allowed(actor, perm)) {
    return res.status(403).json({ error: 'غير مصرح' });
  }

  const body = { ...req.body };
  const rid = body.id ? Number(body.id) : null;
  delete body.id;

  try {
    let fieldsToSave: Record<string, any> = {};

    if (table === 'staff') {
      const username = (body.username || '').trim();
      if (!username) throw new Error('اسم الدخول مطلوب');

      const permissions = Array.isArray(body.permissions) ? body.permissions : [];
      if (actor.role !== 'owner') {
        const actorPerms = actor.permissions || [];
        if (!permissions.every((p: string) => actorPerms.includes(p))) {
          throw new Error('لا يمكن منح صلاحيات لا تمتلكها');
        }
      }

      fieldsToSave = {
        username,
        permissions: JSON.stringify(permissions),
        telegram_id: body.telegram_id ? Number(body.telegram_id) : null,
        enabled: body.enabled !== false && body.enabled !== 0 ? 1 : 0,
      };

      if (body.password) {
        if (body.password.length < 12) throw new Error('كلمة المرور لا تقل عن 12 حرفًا');
        fieldsToSave.password = await bcrypt.hash(body.password, 10);
      } else if (!rid) {
        throw new Error('كلمة المرور مطلوبة');
      }

      if (!rid) {
        fieldsToSave.created = now();
        fieldsToSave.added_by = String(actor.id);
      } else if (fieldsToSave.password) {
        const curStaff = db.prepare('SELECT auth_version FROM staff WHERE id=?').get(rid) as any;
        fieldsToSave.auth_version = (curStaff?.auth_version || 0) + 1;
      }
    } else if (table in SCHEMAS) {
      for (const [col, typ] of Object.entries(SCHEMAS[table])) {
        if (!(col in body)) continue;
        let val = body[col];
        if (typ === 'money') {
          val = cents(val);
        } else if (typ === 'int') {
          val = Number(val);
        } else if (typ === 'bool') {
          val = val ? 1 : 0;
        } else if (typ.includes('|')) {
          if (!typ.split('|').includes(val)) {
            throw new Error('قيمة غير مسموحة: ' + col);
          }
        } else {
          val = String(val);
        }
        fieldsToSave[col] = val;
      }

      if (table === 'services') {
        if (fieldsToSave.price !== undefined && fieldsToSave.price < 0) {
          throw new Error('السعر يجب أن يكون 0 أو أكثر');
        }
      }

      if (table === 'inventory') {
        fieldsToSave.updated = now();
        fieldsToSave.updated_by = String(actor.id);
        if (!rid) {
          fieldsToSave.created = now();
          fieldsToSave.added_by = String(actor.id);
        }
      }

      if (table === 'broadcasts' && !rid) {
        fieldsToSave.created = now();
      }
    } else {
      throw new Error('استخدم الإجراء المخصص لتعديل هذا السجل');
    }

    if (Object.keys(fieldsToSave).length === 0) {
      throw new Error('لا توجد تعديلات لحفظها');
    }

    let resultId = rid;
    if (rid) {
      const sets = Object.keys(fieldsToSave).map((k) => `${k}=?`).join(', ');
      db.prepare(`UPDATE ${table} SET ${sets} WHERE id=?`).run(...Object.values(fieldsToSave), rid);
    } else {
      const cols = Object.keys(fieldsToSave).join(', ');
      const placeholders = Object.keys(fieldsToSave).map(() => '?').join(', ');
      const insert = db.prepare(`INSERT INTO ${table}(${cols}) VALUES(${placeholders})`).run(...Object.values(fieldsToSave));
      resultId = Number(insert.lastInsertRowid);
    }

    audit(actor.id, `${table}.save`, resultId, { fields: Object.keys(fieldsToSave) });
    res.json({ ok: true, id: resultId });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'خطأ أثناء الحفظ' });
  }
});

// 11. Delete record: POST /api/delete/:table/:rid
app.post('/api/delete/:table/:rid', requireAuth(), (req: Request, res: Response) => {
  const actor = (req as any).actor;
  const { table, rid: ridStr } = req.params;
  const rid = Number(ridStr);
  const perm = TABLE_PERM[table];

  if (!perm || !allowed(actor, perm)) {
    return res.status(403).json({ error: 'غير مصرح' });
  }

  try {
    if (table === 'staff') {
      const target = db.prepare('SELECT role FROM staff WHERE id=?').get(rid) as any;
      if (!target || target.role === 'owner' || rid === actor.id) {
        throw new Error('لا يمكن حذف المالك أو حسابك الذاتي');
      }
      db.prepare('UPDATE staff SET enabled=0 WHERE id=?').run(rid);
    } else if (['services', 'inventory'].includes(table)) {
      db.prepare(`UPDATE ${table} SET deleted=1 WHERE id=?`).run(rid);
    } else if (table === 'menus') {
      const menu = db.prepare('SELECT * FROM menus WHERE id=?').get(rid) as any;
      if (!menu) throw new Error('القائمة غير موجودة');
      if (['home', 'services', 'topup', 'account', 'myorders', 'support', 'maintenance', 'error', 'expired'].includes(menu.key)) {
        throw new Error('قائمة نظام أساسية: يمكنك تعديلها دون حذفها');
      }
      db.prepare('DELETE FROM buttons WHERE menu_id=?').run(rid);
      db.prepare('DELETE FROM menus WHERE id=?').run(rid);
    } else if (table === 'buttons') {
      db.prepare('DELETE FROM buttons WHERE id=?').run(rid);
    } else {
      throw new Error('حذف غير مدعوم لهذا الجدول');
    }

    audit(actor.id, `${table}.delete`, rid, {});
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'خطأ أثناء الحذف' });
  }
});

// 12. Actions: POST /api/action/:action
app.post('/api/action/:action', requireAuth(), (req: Request, res: Response) => {
  const actor = (req as any).actor;
  const actionName = req.params.action;
  const body = req.body || {};

  try {
    if (actionName === 'order') {
      if (!allowed(actor, 'orders')) return res.status(403).json({ error: 'غير مصرح' });
      const { id, status, note } = body;
      const order = db.prepare('SELECT * FROM orders WHERE id=?').get(id) as any;
      if (!order) throw new Error('الطلب غير موجود');

      if (!isOrderTransitionValid(order.status, status)) {
        throw new Error('انتقال حالة غير مسموح. لا يمكن إعادة فتح طلب نهائي.');
      }

      let refund_id = order.refund_id;
      if (['cancelled', 'refunded'].includes(status) && !order.refunded) {
        // Refund to user
        const user = db.prepare('SELECT balance FROM users WHERE id=?').get(order.user_id) as any;
        const newBalance = (user?.balance || 0) + order.price;
        db.prepare('UPDATE users SET balance=? WHERE id=?').run(newBalance, order.user_id);

        const insLedger = db.prepare(
          'INSERT INTO ledger(user_id, delta, before_balance, after_balance, reason, actor, operation_key, order_id, created) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(order.user_id, order.price, user.balance, newBalance, `استرداد TK-${String(id).padStart(5, '0')}`, String(actor.id), `refund:${id}`, id, now());
        refund_id = Number(insLedger.lastInsertRowid);
      }

      db.prepare(
        'UPDATE orders SET status=?, refunded=?, refund_id=?, note=?, updated=?, completed=? WHERE id=?'
      ).run(
        status,
        ['cancelled', 'refunded'].includes(status) ? 1 : 0,
        refund_id,
        note || order.note,
        now(),
        status === 'completed' ? now() : order.completed,
        id
      );

      audit(actor.id, 'order.status', id, { before: order.status, after: status, note });
      return res.json({ ok: true });
    }

    if (actionName === 'topup') {
      if (!allowed(actor, 'topups_approve')) return res.status(403).json({ error: 'غير مصرح' });
      const { id, accept, reason } = body;
      const topup = db.prepare('SELECT * FROM topups WHERE id=?').get(id) as any;
      if (!topup) throw new Error('طلب الشحن غير موجود');
      if (['approved', 'rejected'].includes(topup.status)) {
        throw new Error('تمت معالجة الطلب مسبقًا؛ لن تتكرر العملية.');
      }
      if (!accept && !(reason || '').trim()) {
        throw new Error('سبب الرفض مطلوب');
      }

      if (accept) {
        const user = db.prepare('SELECT balance FROM users WHERE id=?').get(topup.user_id) as any;
        const newBalance = (user?.balance || 0) + topup.amount;
        db.prepare('UPDATE users SET balance=? WHERE id=?').run(newBalance, topup.user_id);

        db.prepare(
          'INSERT INTO ledger(user_id, delta, before_balance, after_balance, reason, actor, operation_key, created) VALUES(?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(topup.user_id, topup.amount, user.balance, newBalance, `شحن TOP-${String(id).padStart(5, '0')}`, String(actor.id), `topup:${id}`, now());
      }

      const newStatus = accept ? 'approved' : 'rejected';
      db.prepare('UPDATE topups SET status=?, reason=?, updated=? WHERE id=?').run(newStatus, reason || '', now(), id);

      audit(actor.id, `topup.${newStatus}`, id, { reason });
      return res.json({ ok: true });
    }

    if (actionName === 'topup_note') {
      if (!allowed(actor, 'topups')) return res.status(403).json({ error: 'غير مصرح' });
      db.prepare('UPDATE topups SET note=?, updated=? WHERE id=?').run(body.note || '', now(), body.id);
      return res.json({ ok: true });
    }

    if (actionName === 'balance') {
      if (!allowed(actor, 'balances')) return res.status(403).json({ error: 'غير مصرح' });
      const { user_id, amount, reason } = body;
      const deltaCents = cents(amount);
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(user_id) as any;
      if (!user) throw new Error('المستخدم غير موجود');

      const after = user.balance + deltaCents;
      if (after < 0) throw new Error('الرصيد لا يمكن أن يكون سالبًا');

      db.prepare('UPDATE users SET balance=? WHERE id=?').run(after, user_id);
      const opKey = `balance:${user_id}:${Date.now()}`;
      db.prepare(
        'INSERT INTO ledger(user_id, delta, before_balance, after_balance, reason, actor, operation_key, created) VALUES(?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(user_id, deltaCents, user.balance, after, reason || 'تعديل رصيد يدوي', String(actor.id), opKey, now());

      audit(actor.id, 'user.balance_adjust', user_id, { delta: deltaCents, reason });
      return res.json({ ok: true });
    }

    if (actionName === 'user') {
      if (!allowed(actor, 'users_manage')) return res.status(403).json({ error: 'غير مصرح' });
      const { id, status, note } = body;
      if (!['active', 'blocked'].includes(status)) throw new Error('حالة غير صالحة');
      db.prepare('UPDATE users SET status=?, note=? WHERE id=?').run(status, note || '', id);
      audit(actor.id, 'user.status', id, { status, note });
      return res.json({ ok: true });
    }

    if (actionName === 'ticket') {
      if (!allowed(actor, 'support')) return res.status(403).json({ error: 'غير مصرح' });
      const { id, status } = body;
      if (!['open', 'processing', 'closed'].includes(status)) throw new Error('حالة غير صالحة');
      db.prepare('UPDATE tickets SET status=?, updated=? WHERE id=?').run(status, now(), id);
      audit(actor.id, 'ticket.status', id, { status });
      return res.json({ ok: true });
    }

    if (actionName === 'reply') {
      if (!allowed(actor, 'support')) return res.status(403).json({ error: 'غير مصرح' });
      const { id, body: replyText } = body;
      if (!(replyText || '').trim()) throw new Error('الرسالة فارغة');
      db.prepare('INSERT INTO messages(ticket_id, actor, body, created) VALUES(?, ?, ?, ?)').run(
        id,
        String(actor.id),
        replyText.trim(),
        now()
      );
      db.prepare("UPDATE tickets SET status='processing', updated=? WHERE id=?").run(now(), id);
      audit(actor.id, 'ticket.reply', id, { replyText });
      return res.json({ ok: true });
    }

    if (actionName === 'broadcast') {
      if (!allowed(actor, 'broadcasts')) return res.status(403).json({ error: 'غير مصرح' });
      const { id, status } = body;
      const b = db.prepare('SELECT * FROM broadcasts WHERE id=?').get(id) as any;
      if (!b) throw new Error('الإذاعة غير موجودة');

      if (!isBroadcastTransitionValid(b.status, status)) {
        throw new Error('انتقال إذاعة غير مسموح');
      }

      if (b.status === 'draft' && status === 'running') {
        let userFilter = '1=1';
        if (b.audience === 'active') userFilter = 'status="active"';
        else if (b.audience === 'balance') userFilter = 'balance>0';
        else if (b.audience === 'orders') userFilter = 'EXISTS(SELECT 1 FROM orders WHERE orders.user_id=users.id)';

        db.prepare(
          `INSERT OR IGNORE INTO deliveries(broadcast_id, user_id) SELECT ?, id FROM users WHERE ${userFilter}`
        ).run(id);
      }

      db.prepare('UPDATE broadcasts SET status=? WHERE id=?').run(status, id);
      audit(actor.id, 'broadcast.status', id, { before: b.status, after: status });
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'إجراء غير معروف' });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'خطأ أثناء تنفيذ الإجراء' });
  }
});

// 13. Studio Operations
app.post('/api/studio/:op', requireAuth('menus'), (req: Request, res: Response) => {
  const actor = (req as any).actor;
  const op = req.params.op;
  const body = req.body || {};

  try {
    if (op === 'clone-menu') {
      const { id, key, name } = body;
      if (!key) throw new Error('معرف القائمة مطلوب');
      const m = db.prepare('SELECT * FROM menus WHERE id=?').get(id) as any;
      if (!m) throw new Error('القائمة غير موجودة');

      const insert = db.prepare(
        'INSERT INTO menus(name, key, text, kind, layout_key) VALUES(?, ?, ?, ?, ?)'
      ).run(name || m.name + ' — نسخة', key, m.text, m.kind, m.layout_key);

      const newId = Number(insert.lastInsertRowid);
      const buttons = db.prepare('SELECT * FROM buttons WHERE menu_id=?').all(id) as any[];
      for (const btn of buttons) {
        db.prepare(
          'INSERT INTO buttons(menu_id, label, kind, action, target, row_num, col_num, enabled, permission, child_menu) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(newId, btn.label, btn.kind, btn.action, btn.target, btn.row_num, btn.col_num, btn.enabled, btn.permission, btn.child_menu);
      }

      audit(actor.id, 'menu.cloned', newId, { from: id, key });
      return res.json({ ok: true, id: newId });
    }

    if (op === 'move-button') {
      const { id, direction } = body;
      const btn = db.prepare('SELECT * FROM buttons WHERE id=?').get(id) as any;
      if (!btn) throw new Error('الزر غير موجود');

      let row = btn.row_num;
      let col = btn.col_num;
      if (direction === 'up') row = Math.max(0, row - 1);
      else if (direction === 'down') row = row + 1;
      else if (direction === 'right') col = Math.max(0, col - 1);
      else if (direction === 'left') col = col + 1;

      const occupied = db.prepare('SELECT id FROM buttons WHERE menu_id=? AND row_num=? AND col_num=? AND id!=?').get(btn.menu_id, row, col, id) as any;
      if (occupied) {
        db.prepare('UPDATE buttons SET row_num=?, col_num=? WHERE id=?').run(btn.row_num, btn.col_num, occupied.id);
      }
      db.prepare('UPDATE buttons SET row_num=?, col_num=? WHERE id=?').run(row, col, id);

      audit(actor.id, 'button.moved', id, { direction, row, col });
      return res.json({ ok: true, id });
    }

    if (op === 'bind-screen') {
      const { screen, layout } = body;
      db.prepare('UPDATE menus SET layout_key=? WHERE key=?').run(layout || '', screen);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'إجراء محرر غير معروف' });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'خطأ في عملية المحرر' });
  }
});

// 14. Workflows
app.post('/api/workflows', requireAuth('menus'), (req: Request, res: Response) => {
  const actor = (req as any).actor;
  const { id, name, enabled, steps } = req.body || {};

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'اسم التدفق مطلوب' });
  }

  const stepsJson = JSON.stringify(steps || []);
  let fid = id;

  if (id) {
    db.prepare('UPDATE workflows SET name=?, enabled=?, steps=?, revision=revision+1, updated=? WHERE id=?').run(
      name,
      enabled ? 1 : 0,
      stepsJson,
      now(),
      id
    );
  } else {
    const insert = db.prepare(
      'INSERT INTO workflows(name, steps, enabled, created, updated) VALUES(?, ?, ?, ?, ?)'
    ).run(name, stepsJson, enabled ? 1 : 0, now(), now());
    fid = Number(insert.lastInsertRowid);
  }

  audit(actor.id, 'workflow.saved', fid, { name });
  res.json({ ok: true, id: fid });
});

// 15. Simulate Bot
app.post('/api/simulate', requireAuth('menus'), (req: Request, res: Response) => {
  const { route, inputs } = req.body || {};
  const targetMenuKey = route || 'home';

  const menu = db.prepare('SELECT * FROM menus WHERE key=?').get(targetMenuKey) as any;
  const text = menu ? menu.text : '🎵 أهلاً بك في TikTok Services Bot';

  const buttons = menu ? db.prepare('SELECT * FROM buttons WHERE menu_id=? AND enabled=1 ORDER BY row_num, col_num').all(menu.id) as any[] : [];

  res.json({
    messages: [
      {
        method: 'sendMessage',
        data: {
          text,
          buttons: buttons.map((b) => ({ text: b.label, callback_data: b.target || b.action })),
        },
      },
    ],
    state: targetMenuKey,
  });
});

// 16. Settings Save
app.post('/api/settings', requireAuth('settings'), (req: Request, res: Response) => {
  const actor = (req as any).actor;
  const body = req.body || {};

  const permitted = [
    'brand',
    'maintenance',
    'maintenance_staff',
    'manual_enabled',
    'stars_enabled',
    'topup_min',
    'topup_max',
    'stars_rate',
    'transfer_instructions',
    'order_min',
    'order_max',
    'session_minutes',
    'owner_telegram_id',
    'language',
    'notifications_enabled',
    'web_url',
    'support_enabled',
    'customer_cancel_pending',
  ];

  for (const k of permitted) {
    if (k in body) {
      putSetting(k, body[k]);
    }
  }

  audit(actor.id, 'settings.save', 'system', body);
  res.json({ ok: true });
});

// 17. Connect Telegram Bot Token
app.post('/api/connect', requireAuth('settings'), async (req: Request, res: Response) => {
  const actor = (req as any).actor;
  const token = (req.body.token || '').trim();

  if (!token || !token.includes(':')) {
    return res.status(400).json({ error: 'أدخل توكن Telegram صحيحًا بصيغة 123456:ABC...' });
  }

  try {
    // 1. Verify token by calling getMe on Telegram API
    const me = await callTelegram(token, 'getMe');

    // 2. Clear any active webhook so long-polling receives updates immediately
    try {
      await callTelegram(token, 'deleteWebhook', { drop_pending_updates: false });
    } catch (whErr: any) {
      console.warn('deleteWebhook warning:', whErr.message);
    }

    // 3. Register standard bot commands
    try {
      await callTelegram(token, 'setMyCommands', {
        commands: [
          { command: 'start', description: 'بدء استخدام البوت والقائمة الرئيسية' },
          { command: 'services', description: 'عرض الخدمات المتاحة' },
          { command: 'balance', description: 'عرض رصيدك الحالي' },
          { command: 'orders', description: 'عرض طلباتك السابقة' },
          { command: 'topup', description: 'شحن الرصيد' },
          { command: 'support', description: 'الدعم الفني والمساعدة' },
        ],
      });
    } catch (cmdErr: any) {
      console.warn('setMyCommands warning:', cmdErr.message);
    }

    const botIdentity = {
      id: me.id,
      is_bot: true,
      first_name: me.first_name || 'TikTok Services Bot',
      username: me.username || '',
    };

    putSetting('telegram_token', token);
    putSetting('bot_identity', botIdentity);

    botRuntimeState.status = 'connected';
    botRuntimeState.botUsername = me.username || '';
    botRuntimeState.error = '';

    audit(actor.id, 'bot.connected', botIdentity.id, { username: botIdentity.username });
    res.json({ ok: true, bot: botIdentity });
  } catch (err: any) {
    console.error('Telegram bot connect error:', err);
    botRuntimeState.status = 'error';
    botRuntimeState.error = err.message || 'فشل الاتصال بـ Telegram API';
    return res.status(400).json({
      error: `فشل التحقق من التوكن: ${err.message || 'تأكد من صحة التوكن ومطابقته لتعليمات BotFather'}`,
    });
  }
});

// Static assets & SPA
app.use('/static', express.static(STATIC_DIR));

// All unhandled /api calls return JSON 404
app.all('/api/*', (req: Request, res: Response) => {
  res.status(404).json({ error: 'المسار غير موجود' });
});

// SPA fallback for HTML pages
app.get('*', (req: Request, res: Response) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

// Global JSON error handler
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled server error:', err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: err.message || 'حدث خطأ في الخادم' });
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`TikTok Services Control Center running at http://0.0.0.0:${PORT}`);
});
