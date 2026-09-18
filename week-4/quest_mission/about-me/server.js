require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { Pool, types } = require('pg');

// BIGINT(id) 를 문자열 대신 숫자로 받는다 (messages.json 의 id 와 형식 통일)
types.setTypeParser(types.builtins.INT8, Number);

const app = express();
// 3000 은 coin invest·memo 등 다른 실습 서버가 쓰므로 about-me 는 3005 를 기본으로 쓴다.
const PORT = process.env.PORT || 3005;

// ── 설정 ─────────────────────────────────────────────────────────

const MESSAGES_FILE = path.join(__dirname, 'messages.json');
const MAX_NAME = 50;
const MAX_EMAIL = 254;
const MAX_CONTENT = 2000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── 관리자 인증 설정 ─────────────────────────────────────────────

// 계정은 .env 로만 주입한다 (index.html 에 넣으면 누구나 소스에서 볼 수 있다).
const ADMIN_ID = (process.env.ADMIN_ID || '').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 로그인 유지 12시간
const LOGIN_MAX_FAILS = 5;                 // IP 당 연속 실패 허용 횟수
const LOGIN_LOCK_MS = 10 * 60 * 1000;      // 초과 시 잠금 시간

// 서명 키가 없으면 실행 시 임시 발급 (재시작하면 기존 로그인은 풀린다)
let TOKEN_SECRET = (process.env.ADMIN_TOKEN_SECRET || '').trim();
if (!TOKEN_SECRET) {
  TOKEN_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] ADMIN_TOKEN_SECRET 이 없어 임시 키를 사용합니다. 재시작 시 로그인이 풀립니다.');
}
if (!ADMIN_ID || !ADMIN_PASSWORD) {
  console.warn('[auth] ADMIN_ID / ADMIN_PASSWORD 가 설정되지 않아 관리자 로그인이 불가능합니다.');
}

// ── DB 연결 (Supabase Postgres) ──────────────────────────────────

// 접속 문자열은 .env 의 DATABASE_URL 로만 주입한다 (코드에 하드코딩 금지).
// 직접 호스트 db.<ref>.supabase.co 는 IPv6 전용이므로 IPv4 풀러 주소를 쓴다.
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Supabase 는 SSL 필수
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    })
  : null;

if (pool) pool.on('error', (err) => console.error('[pg] idle client error:', err.message));

// 서버리스 cold start 마다 호출될 수 있으므로 flag 로 중복 실행을 막는다.
let dbInitialized = false;
async function initDB() {
  if (!pool || dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contact_messages (
      id          BIGSERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      email       TEXT NOT NULL,
      content     TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  dbInitialized = true;
}

// ── messages.json 저장소 ─────────────────────────────────────────

async function readMessagesFile() {
  try {
    const list = JSON.parse(await fs.readFile(MESSAGES_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// 동시 요청이 서로의 쓰기를 덮어쓰지 않도록 쓰기를 한 줄로 세운다.
let writeQueue = Promise.resolve();
function appendMessageFile(message) {
  const task = writeQueue.then(async () => {
    const list = await readMessagesFile();
    list.push(message);
    await fs.writeFile(MESSAGES_FILE, JSON.stringify(list, null, 2) + '\n', 'utf8');
  });
  writeQueue = task.catch(() => {});
  return task;
}

// ── 관리자 인증 (서명 토큰) ──────────────────────────────────────

// 서버리스 인스턴스끼리 세션을 공유할 수 없으므로, 세션 저장 없이 검증 가능한 HMAC 서명 토큰을 쓴다.
// 형식: base64url({ sub, exp }) + "." + base64url(HMAC-SHA256)
const sign = (payload) => crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');

function createToken(sub) {
  const payload = Buffer.from(JSON.stringify({ sub, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

// 길이가 달라도 비교 시간이 새지 않도록 해시끼리 상수 시간 비교
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// 무차별 대입 방지: IP 별 실패 횟수 (인메모리)
const loginFailures = new Map(); // ip -> { count, lockedUntil }

function requireAdmin(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const session = verifyToken(token);
  if (!session) {
    return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
  }
  req.admin = session;
  next();
}

// ── 유틸 ─────────────────────────────────────────────────────────

// 이름/이메일/내용 검증 → { error } 또는 { name, email, content }
function parseMessageBody(body) {
  const { name, email, content } = body || {};
  if ([name, email, content].some((v) => typeof v !== 'string')) {
    return { error: '이름, 이메일, 내용을 모두 입력해 주세요.' };
  }
  const trimmed = { name: name.trim(), email: email.trim(), content: content.trim() };
  if (!trimmed.name) return { error: '이름을 입력해 주세요.' };
  if (trimmed.name.length > MAX_NAME) return { error: `이름은 ${MAX_NAME}자 이하로 입력해 주세요.` };
  if (!EMAIL_RE.test(trimmed.email) || trimmed.email.length > MAX_EMAIL) {
    return { error: '올바른 이메일 주소를 입력해 주세요.' };
  }
  if (!trimmed.content) return { error: '문의 내용을 입력해 주세요.' };
  if (trimmed.content.length > MAX_CONTENT) {
    return { error: `내용은 ${MAX_CONTENT.toLocaleString()}자 이하로 입력해 주세요.` };
  }
  return trimmed;
}

// ── 미들웨어 ─────────────────────────────────────────────────────

app.set('trust proxy', 1); // Vercel 프록시 뒤에서도 req.ip 가 실제 접속자 IP 가 되도록
app.use(express.json({ limit: '50kb' }));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('[db] init failed:', err.message);
    res.status(500).json({ success: false, message: '데이터베이스 연결에 실패했습니다.' });
  }
});

// ── API: GET ─────────────────────────────────────────────────────

// 로그인 상태 확인 (토큰 유효성)
app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ success: true, data: { id: req.admin.sub, expiresAt: new Date(req.admin.exp).toISOString() } });
});

// 문의 목록 (최신순, 관리자 전용). DB 가 설정돼 있으면 DB, 아니면 messages.json 에서 읽는다.
app.get('/api/messages', requireAdmin, async (_req, res, next) => {
  try {
    if (pool) {
      const { rows } = await pool.query(
        `SELECT id, name, email, content, received_at
           FROM contact_messages
          ORDER BY received_at DESC, id DESC`
      );
      return res.json({ success: true, source: 'database', data: rows });
    }
    const list = await readMessagesFile();
    list.sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
    res.json({ success: true, source: 'file', data: list });
  } catch (err) {
    next(err);
  }
});

// ── API: POST ────────────────────────────────────────────────────

// 관리자 로그인 → 토큰 발급
app.post('/api/admin/login', (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  const record = loginFailures.get(ip);
  if (record && record.lockedUntil > now) {
    const minutes = Math.ceil((record.lockedUntil - now) / 60000);
    return res.status(429).json({ success: false, message: `로그인 시도가 너무 많습니다. ${minutes}분 후 다시 시도해 주세요.` });
  }

  const { id, password } = req.body || {};
  if (typeof id !== 'string' || typeof password !== 'string' || !id.trim() || !password) {
    return res.status(400).json({ success: false, message: '아이디와 비밀번호를 입력해 주세요.' });
  }

  // 아이디·비밀번호를 모두 비교한 뒤 판정 (어느 쪽이 틀렸는지 알려주지 않는다)
  const idOk = safeEqual(id.trim(), ADMIN_ID);
  const pwOk = safeEqual(password, ADMIN_PASSWORD);
  if (!ADMIN_ID || !ADMIN_PASSWORD || !idOk || !pwOk) {
    // 잠금이 풀린 기록은 0 부터 다시 센다
    const count = (record && !record.lockedUntil ? record.count : 0) + 1;
    loginFailures.set(ip, { count, lockedUntil: count >= LOGIN_MAX_FAILS ? now + LOGIN_LOCK_MS : 0 });
    const left = LOGIN_MAX_FAILS - count;
    return res.status(401).json({
      success: false,
      message: left > 0
        ? `아이디 또는 비밀번호가 올바르지 않습니다. (남은 시도 ${left}회)`
        : `로그인 시도가 너무 많습니다. ${LOGIN_LOCK_MS / 60000}분 후 다시 시도해 주세요.`,
    });
  }

  loginFailures.delete(ip);
  res.json({ success: true, data: { token: createToken(ADMIN_ID), expiresIn: TOKEN_TTL_MS } });
});

// 문의 접수: DB 에 저장하고 messages.json 에도 받은 시간과 함께 기록한다.
app.post('/api/messages', async (req, res, next) => {
  try {
    const parsed = parseMessageBody(req.body);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });

    if (!pool) {
      const list = await readMessagesFile();
      const message = {
        id: list.reduce((max, m) => Math.max(max, Number(m.id) || 0), 0) + 1,
        ...parsed,
        received_at: new Date().toISOString(),
      };
      await appendMessageFile(message);
      return res.status(201).json({ success: true, data: message });
    }

    const { rows } = await pool.query(
      `INSERT INTO contact_messages (name, email, content) VALUES ($1, $2, $3)
       RETURNING id, name, email, content, received_at`,
      [parsed.name, parsed.email, parsed.content]
    );
    const saved = rows[0];

    // 파일 기록은 백업용. Vercel 처럼 파일시스템이 읽기 전용이면 실패해도 접수는 성공 처리한다.
    try {
      await appendMessageFile({ ...saved, received_at: saved.received_at.toISOString() });
    } catch (err) {
      console.warn('[file] messages.json 기록 실패:', err.message);
    }

    res.status(201).json({ success: true, data: saved });
  } catch (err) {
    next(err);
  }
});

// ── API 404 & SPA fallback (Express 5 문법) ───────────────────────

app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: '존재하지 않는 API입니다.' });
});

// /admin 등 모든 페이지 경로는 index.html 이 받아서 화면을 고른다.
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── 에러 핸들러 ──────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: '요청 형식(JSON)이 올바르지 않습니다.' });
  }
  console.error(err);
  res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`About-me server running on http://localhost:${PORT}`);
    console.log(`저장소: ${pool ? 'Supabase Postgres (contact_messages) + messages.json' : 'messages.json'}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`포트 ${PORT} 를 이미 다른 서버가 쓰고 있습니다. 해당 서버를 끄거나 PORT=다른번호 로 실행해 주세요.`);
      process.exit(1);
    }
    throw err;
  });
}
module.exports = app;
