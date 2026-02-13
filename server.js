require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const app = express();

const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const APP_ORIGIN = process.env.APP_ORIGIN || "";
const APP_ORIGIN_REGEX = process.env.APP_ORIGIN_REGEX || "";
const JWT_SECRET = String(process.env.JWT_SECRET || "");
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const COOKIE_NAME = process.env.COOKIE_NAME || "apptest_session";
const CSRF_COOKIE_NAME = process.env.CSRF_COOKIE_NAME || "apptest_csrf";
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

if (JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET deve essere impostato e lungo almeno 32 caratteri.");
}
if (IS_PROD && !APP_ORIGIN && !APP_ORIGIN_REGEX) {
  throw new Error(
    "In produzione devi impostare APP_ORIGIN (es: https://app.tuodominio.com) oppure APP_ORIGIN_REGEX."
  );
}
if (!Number.isInteger(BCRYPT_ROUNDS) || BCRYPT_ROUNDS < 10 || BCRYPT_ROUNDS > 14) {
  throw new Error("BCRYPT_ROUNDS deve essere un intero tra 10 e 14.");
}
if (TRUST_PROXY) {
  app.set("trust proxy", 1);
}

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "app.db");
const PUBLIC_DIR = path.join(__dirname, "public");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS work_entries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_work_entries_user_start ON work_entries(user_id, start_at);
  CREATE INDEX IF NOT EXISTS idx_work_entries_user_end ON work_entries(user_id, end_at);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS day_adjustments (
    user_id TEXT NOT NULL,
    day_date TEXT NOT NULL,
    day_type TEXT NOT NULL DEFAULT 'none',
    permission_minutes INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, day_date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_day_adjustments_user_day ON day_adjustments(user_id, day_date);
`);

const insertUserStmt = db.prepare(`
  INSERT INTO users (id, name, email, password_hash, created_at)
  VALUES (@id, @name, @email, @password_hash, @created_at)
`);
const findUserByEmailStmt = db.prepare(`
  SELECT id, name, email, password_hash, created_at
  FROM users
  WHERE email = ?
`);
const findUserByIdStmt = db.prepare(`
  SELECT id, name, email, created_at
  FROM users
  WHERE id = ?
`);

const insertWorkEntryStmt = db.prepare(`
  INSERT INTO work_entries (id, user_id, start_at, end_at, created_at, updated_at)
  VALUES (@id, @user_id, @start_at, @end_at, @created_at, @updated_at)
`);
const findActiveWorkEntryStmt = db.prepare(`
  SELECT id, user_id, start_at, end_at, created_at, updated_at
  FROM work_entries
  WHERE user_id = ? AND end_at IS NULL
  ORDER BY start_at DESC
  LIMIT 1
`);
const stopWorkEntryStmt = db.prepare(`
  UPDATE work_entries
  SET end_at = @end_at, updated_at = @updated_at
  WHERE id = @id AND user_id = @user_id
`);
const findEntriesInRangeStmt = db.prepare(`
  SELECT id, user_id, start_at, end_at, created_at, updated_at
  FROM work_entries
  WHERE user_id = @user_id
    AND start_at < @to_iso
    AND (end_at IS NULL OR end_at >= @from_iso)
  ORDER BY start_at ASC
`);
const findEntryByIdStmt = db.prepare(`
  SELECT id, user_id, start_at, end_at, created_at, updated_at
  FROM work_entries
  WHERE id = ? AND user_id = ?
`);
const updateWorkEntryStmt = db.prepare(`
  UPDATE work_entries
  SET start_at = @start_at, end_at = @end_at, updated_at = @updated_at
  WHERE id = @id AND user_id = @user_id
`);
const deleteEntriesByRangeStmt = db.prepare(`
  DELETE FROM work_entries
  WHERE user_id = @user_id
    AND start_at >= @from_iso
    AND start_at < @to_iso
`);
const deleteDayAdjustmentStmt = db.prepare(`
  DELETE FROM day_adjustments
  WHERE user_id = @user_id
    AND day_date = @day_date
`);
const findOverlapStmt = db.prepare(`
  SELECT id
  FROM work_entries
  WHERE user_id = @user_id
    AND id != @id
    AND start_at < @end_at
    AND COALESCE(end_at, '9999-12-31T23:59:59.999Z') > @start_at
  LIMIT 1
`);
const findAdjustmentsInRangeStmt = db.prepare(`
  SELECT user_id, day_date, day_type, permission_minutes, updated_at
  FROM day_adjustments
  WHERE user_id = @user_id
    AND day_date >= @from_day
    AND day_date < @to_day
  ORDER BY day_date ASC
`);
const upsertAdjustmentStmt = db.prepare(`
  INSERT INTO day_adjustments (user_id, day_date, day_type, permission_minutes, updated_at)
  VALUES (@user_id, @day_date, @day_type, @permission_minutes, @updated_at)
  ON CONFLICT(user_id, day_date)
  DO UPDATE SET
    day_type = excluded.day_type,
    permission_minutes = excluded.permission_minutes,
    updated_at = excluded.updated_at
`);

function sanitizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function sanitizeName(value) {
  return String(value || "").trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isStrongEnoughPassword(password) {
  return (
    password.length >= 8 &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /\d/.test(password)
  );
}

function toIsoOrNull(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function isValidDayDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function isoToDayDate(isoString) {
  return String(isoString).slice(0, 10);
}

function dayDateToIsoRange(dayDate) {
  const from = new Date(`${dayDate}T00:00:00`);
  if (Number.isNaN(from.getTime())) return null;
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

function normalizeDayType(value) {
  const dayType = String(value || "none").trim().toLowerCase();
  const allowed = new Set(["none", "smart", "ferie", "festa"]);
  return allowed.has(dayType) ? dayType : null;
}

function normalizePermissionMinutes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.round(parsed);
  if (rounded < 0 || rounded > 12 * 60) return null;
  return rounded;
}

function durationMinutes(startAt, endAt) {
  if (!endAt) return null;
  const diff = new Date(endAt).getTime() - new Date(startAt).getTime();
  if (!Number.isFinite(diff) || diff <= 0) return 0;
  return Math.round(diff / 60000);
}

function safeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.created_at,
  };
}

function publicEntry(entry) {
  return {
    id: entry.id,
    startAt: entry.start_at,
    endAt: entry.end_at,
    durationMinutes: durationMinutes(entry.start_at, entry.end_at),
    createdAt: entry.created_at,
    updatedAt: entry.updated_at,
  };
}

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      name: user.name,
    },
    JWT_SECRET,
    {
      expiresIn: JWT_EXPIRES_IN,
      issuer: "app-test",
      audience: "app-test-client",
    }
  );
}

function getTokenFromRequest(req) {
  const cookieToken = req.cookies?.[COOKIE_NAME];
  if (cookieToken) return cookieToken;

  const authorization = req.headers.authorization || "";
  const [type, token] = authorization.split(" ");
  if (type === "Bearer" && token) return token;
  return "";
}

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  };
}

function csrfCookieOptions() {
  return {
    httpOnly: false,
    secure: IS_PROD,
    sameSite: "strict",
    maxAge: 2 * 60 * 60 * 1000,
    path: "/",
  };
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, sessionCookieOptions());
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, sessionCookieOptions());
}

function setCsrfCookie(res, token) {
  res.cookie(CSRF_COOKIE_NAME, token, csrfCookieOptions());
}

function clearCsrfCookie(res) {
  res.clearCookie(CSRF_COOKIE_NAME, csrfCookieOptions());
}

function authMiddleware(req, res, next) {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ error: "Sessione non valida." });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET, {
      issuer: "app-test",
      audience: "app-test-client",
    });
    req.auth = payload;
    return next();
  } catch {
    return res.status(401).json({ error: "Sessione non valida." });
  }
}

function originGuard(req, res, next) {
  if (!IS_PROD) return next();

  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return next();
  }

  const origin = req.headers.origin || "";
  if (!origin) {
    return res.status(403).json({ error: "Origin non autorizzata." });
  }

  const exactMatchAllowed = APP_ORIGIN && origin === APP_ORIGIN;
  let regexMatchAllowed = false;
  if (APP_ORIGIN_REGEX) {
    try {
      const pattern = new RegExp(APP_ORIGIN_REGEX);
      regexMatchAllowed = pattern.test(origin);
    } catch {
      return res.status(500).json({ error: "Configurazione APP_ORIGIN_REGEX non valida." });
    }
  }

  if (!exactMatchAllowed && !regexMatchAllowed) {
    return res.status(403).json({ error: "Origin non autorizzata." });
  }

  return next();
}

function csrfGuard(req, res, next) {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return next();
  }

  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME] || "";
  const headerToken = req.headers["x-csrf-token"] || "";

  if (!cookieToken || !headerToken) {
    return res.status(403).json({ error: "CSRF token mancante." });
  }

  const a = Buffer.from(cookieToken);
  const b = Buffer.from(String(headerToken));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: "CSRF token non valido." });
  }

  return next();
}

function requireIsoRange(req, res, next) {
  const fromIso = toIsoOrNull(req.query.from);
  const toIso = toIsoOrNull(req.query.to);
  if (!fromIso || !toIso) {
    return res.status(400).json({ error: "Intervallo non valido." });
  }

  if (new Date(fromIso).getTime() >= new Date(toIso).getTime()) {
    return res.status(400).json({ error: "Intervallo non valido." });
  }

  const days = (new Date(toIso).getTime() - new Date(fromIso).getTime()) / (24 * 60 * 60 * 1000);
  if (days > 31) {
    return res.status(400).json({ error: "Intervallo troppo ampio (max 31 giorni)." });
  }

  req.range = { fromIso, toIso };
  return next();
}

app.disable("x-powered-by");
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "https://fonts.googleapis.com"],
  fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
  imgSrc: ["'self'", "data:"],
  connectSrc: ["'self'"],
  frameAncestors: ["'none'"],
  objectSrc: ["'none'"],
};
if (IS_PROD) {
  cspDirectives.upgradeInsecureRequests = [];
}

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: cspDirectives,
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "no-referrer" },
  })
);
app.use(express.json({ limit: "24kb" }));
app.use(cookieParser());
app.use(originGuard);

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 250,
  standardHeaders: true,
  legacyHeaders: false,
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Troppi tentativi. Riprova tra qualche minuto." },
});

app.use(globalLimiter);
app.use("/api/auth", authLimiter);
app.use("/api/auth", csrfGuard);
app.use("/api/timer", authMiddleware);
app.use("/api/timer", csrfGuard);

app.use(
  express.static(PUBLIC_DIR, {
    dotfiles: "deny",
    index: false,
    maxAge: IS_PROD ? "1h" : 0,
    etag: true,
  })
);

app.get("/", (_req, res) => {
  return res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/api/auth/csrf", (_req, res) => {
  const token = crypto.randomBytes(32).toString("base64url");
  setCsrfCookie(res, token);
  return res.json({ token });
});

app.post("/api/auth/register", async (req, res) => {
  const name = sanitizeName(req.body?.name);
  const email = sanitizeEmail(req.body?.email);
  const password = String(req.body?.password || "");

  if (!name || !email || !password) {
    return res.status(400).json({ error: "Nome, email e password sono obbligatori." });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "Email non valida." });
  }
  if (!isStrongEnoughPassword(password)) {
    return res.status(400).json({
      error: "Password debole: minimo 8 caratteri con maiuscola, minuscola e numero.",
    });
  }

  const existing = findUserByEmailStmt.get(email);
  if (existing) {
    return res.status(409).json({ error: "Email gia' registrata." });
  }

  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    password_hash: await bcrypt.hash(password, BCRYPT_ROUNDS),
    created_at: new Date().toISOString(),
  };
  insertUserStmt.run(user);

  setSessionCookie(res, signToken(user));

  return res.status(201).json({
    message: "Registrazione completata.",
    user: safeUser(user),
  });
});

app.post("/api/auth/login", async (req, res) => {
  const email = sanitizeEmail(req.body?.email);
  const password = String(req.body?.password || "");

  if (!email || !password) {
    return res.status(400).json({ error: "Email e password sono obbligatorie." });
  }

  const user = findUserByEmailStmt.get(email);
  if (!user) {
    return res.status(401).json({ error: "Credenziali non valide." });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: "Credenziali non valide." });
  }

  setSessionCookie(res, signToken(user));

  return res.json({
    message: "Login riuscito.",
    user: safeUser(user),
  });
});

app.get("/api/auth/me", authMiddleware, (req, res) => {
  const user = findUserByIdStmt.get(req.auth.sub);
  if (!user) {
    clearSessionCookie(res);
    return res.status(401).json({ error: "Sessione non valida." });
  }

  return res.json({ user: safeUser(user) });
});

app.post("/api/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  clearCsrfCookie(res);
  return res.json({ message: "Logout completato." });
});

app.get("/api/timer/status", (req, res) => {
  const active = findActiveWorkEntryStmt.get(req.auth.sub);
  return res.json({ activeEntry: active ? publicEntry(active) : null });
});

app.post("/api/timer/start", (req, res) => {
  const active = findActiveWorkEntryStmt.get(req.auth.sub);
  if (active) {
    return res.status(409).json({ error: "Hai gia' un timer attivo." });
  }

  const nowIso = new Date().toISOString();
  const entry = {
    id: crypto.randomUUID(),
    user_id: req.auth.sub,
    start_at: nowIso,
    end_at: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
  insertWorkEntryStmt.run(entry);

  return res.status(201).json({
    message: "Ingresso registrato.",
    entry: publicEntry(entry),
  });
});

app.post("/api/timer/stop", (req, res) => {
  const active = findActiveWorkEntryStmt.get(req.auth.sub);
  if (!active) {
    return res.status(409).json({ error: "Nessun timer attivo da chiudere." });
  }

  const endAt = new Date().toISOString();
  if (new Date(endAt).getTime() <= new Date(active.start_at).getTime()) {
    return res.status(400).json({ error: "Orario di uscita non valido." });
  }

  stopWorkEntryStmt.run({
    id: active.id,
    user_id: req.auth.sub,
    end_at: endAt,
    updated_at: endAt,
  });

  const updated = findEntryByIdStmt.get(active.id, req.auth.sub);
  return res.json({
    message: "Uscita registrata.",
    entry: publicEntry(updated),
  });
});

app.get("/api/timer/entries", requireIsoRange, (req, res) => {
  const rows = findEntriesInRangeStmt.all({
    user_id: req.auth.sub,
    from_iso: req.range.fromIso,
    to_iso: req.range.toIso,
  });
  return res.json({ entries: rows.map(publicEntry) });
});

app.get("/api/timer/day-adjustments", requireIsoRange, (req, res) => {
  const fromDay = isoToDayDate(req.range.fromIso);
  const toDay = isoToDayDate(req.range.toIso);
  const rows = findAdjustmentsInRangeStmt.all({
    user_id: req.auth.sub,
    from_day: fromDay,
    to_day: toDay,
  });

  return res.json({
    adjustments: rows.map((row) => ({
      dayDate: row.day_date,
      dayType: row.day_type,
      permissionMinutes: row.permission_minutes,
      updatedAt: row.updated_at,
    })),
  });
});

app.put("/api/timer/day-adjustments/:dayDate", (req, res) => {
  const dayDate = String(req.params.dayDate || "");
  const dayType = normalizeDayType(req.body?.dayType);
  const permissionMinutes = normalizePermissionMinutes(req.body?.permissionMinutes ?? 0);

  if (!isValidDayDate(dayDate) || !dayType || permissionMinutes === null) {
    return res.status(400).json({ error: "Dati giorno non validi." });
  }

  const updatedAt = new Date().toISOString();
  upsertAdjustmentStmt.run({
    user_id: req.auth.sub,
    day_date: dayDate,
    day_type: dayType,
    permission_minutes: permissionMinutes,
    updated_at: updatedAt,
  });

  return res.json({
    message: "Giornata aggiornata.",
    adjustment: {
      dayDate,
      dayType,
      permissionMinutes,
      updatedAt,
    },
  });
});

app.delete("/api/timer/day/:dayDate", (req, res) => {
  const dayDate = String(req.params.dayDate || "");
  if (!isValidDayDate(dayDate)) {
    return res.status(400).json({ error: "Giorno non valido." });
  }
  const range = dayDateToIsoRange(dayDate);
  if (!range) {
    return res.status(400).json({ error: "Giorno non valido." });
  }

  const tx = db.transaction(() => {
    deleteEntriesByRangeStmt.run({
      user_id: req.auth.sub,
      from_iso: range.fromIso,
      to_iso: range.toIso,
    });
    deleteDayAdjustmentStmt.run({
      user_id: req.auth.sub,
      day_date: dayDate,
    });
  });
  tx();

  return res.json({
    message: "Giorno resettato.",
    dayDate,
  });
});

app.post("/api/timer/entries", (req, res) => {
  const startAt = toIsoOrNull(req.body?.startAt);
  const endAt = toIsoOrNull(req.body?.endAt);

  if (!startAt || !endAt) {
    return res.status(400).json({ error: "startAt e endAt sono obbligatori." });
  }
  if (new Date(endAt).getTime() <= new Date(startAt).getTime()) {
    return res.status(400).json({ error: "endAt deve essere successivo a startAt." });
  }

  const overlap = findOverlapStmt.get({
    user_id: req.auth.sub,
    id: "__new__",
    start_at: startAt,
    end_at: endAt,
  });
  if (overlap) {
    return res.status(409).json({ error: "Intervallo sovrapposto a un'altra registrazione." });
  }

  const nowIso = new Date().toISOString();
  const entry = {
    id: crypto.randomUUID(),
    user_id: req.auth.sub,
    start_at: startAt,
    end_at: endAt,
    created_at: nowIso,
    updated_at: nowIso,
  };
  insertWorkEntryStmt.run(entry);

  return res.status(201).json({
    message: "Registrazione manuale salvata.",
    entry: publicEntry(entry),
  });
});

app.put("/api/timer/entries/:entryId", (req, res) => {
  const entryId = String(req.params.entryId || "");
  const startAt = toIsoOrNull(req.body?.startAt);
  const endAt = toIsoOrNull(req.body?.endAt);

  if (!entryId || !startAt || !endAt) {
    return res.status(400).json({ error: "Dati non validi." });
  }
  if (new Date(endAt).getTime() <= new Date(startAt).getTime()) {
    return res.status(400).json({ error: "endAt deve essere successivo a startAt." });
  }

  const current = findEntryByIdStmt.get(entryId, req.auth.sub);
  if (!current) {
    return res.status(404).json({ error: "Registrazione non trovata." });
  }

  const overlap = findOverlapStmt.get({
    user_id: req.auth.sub,
    id: entryId,
    start_at: startAt,
    end_at: endAt,
  });
  if (overlap) {
    return res.status(409).json({ error: "Intervallo sovrapposto a un'altra registrazione." });
  }

  updateWorkEntryStmt.run({
    id: entryId,
    user_id: req.auth.sub,
    start_at: startAt,
    end_at: endAt,
    updated_at: new Date().toISOString(),
  });

  const updated = findEntryByIdStmt.get(entryId, req.auth.sub);
  return res.json({
    message: "Registrazione aggiornata.",
    entry: publicEntry(updated),
  });
});

app.get("/api/health", (_req, res) => {
  db.prepare("SELECT 1").get();
  return res.json({ ok: true, env: NODE_ENV });
});

app.use("/api", (_req, res) => {
  return res.status(404).json({ error: "Endpoint non trovato." });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  return res.status(500).json({ error: "Errore interno." });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Server attivo su http://${HOST}:${PORT}`);
});

function shutdown(signal) {
  console.log(`Ricevuto ${signal}. Chiusura in corso...`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
