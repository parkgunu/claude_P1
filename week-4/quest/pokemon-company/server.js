require('dotenv').config();

const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ── DB 연결 ──────────────────────────────────────────────────────

// 접속 문자열은 .env 의 DATABASE_URL 로만 주입한다 (코드에 하드코딩 금지).
// Vercel 등에서 환경변수 끝에 개행이 붙는 경우가 있어 .trim() 을 건다.
const connectionString = (process.env.DATABASE_URL || '').trim();

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }, // Supabase 는 SSL 필수
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('[pg] idle client error:', err.message));

// 서버리스에서는 cold start 마다 호출될 수 있으므로 flag 로 중복 실행을 막는다.
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inquiries (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      phone      TEXT,
      company    TEXT,
      type       TEXT NOT NULL,
      message    TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  dbInitialized = true;
}

// ── 상수 & 헬퍼 ──────────────────────────────────────────────────

const INQUIRY_TYPES = ['사업제휴', '제품문의', '채용문의', '라이선스', '기타'];

function formatKST(date) {
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function validateInquiry(body) {
  const errors = [];
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const phone = String(body.phone || '').trim();
  const company = String(body.company || '').trim();
  const type = String(body.type || '').trim();
  const message = String(body.message || '').trim();

  if (name.length < 2 || name.length > 40) errors.push('이름은 2~40자로 입력해 주세요');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('이메일 형식이 올바르지 않습니다');
  if (phone && !/^[0-9+\-\s()]{7,20}$/.test(phone)) errors.push('연락처 형식이 올바르지 않습니다');
  if (company.length > 60) errors.push('회사/소속은 60자 이하로 입력해 주세요');
  if (!INQUIRY_TYPES.includes(type)) errors.push(`문의 유형은 ${INQUIRY_TYPES.join(', ')} 중 하나여야 합니다`);
  if (message.length < 5 || message.length > 2000) errors.push('문의 내용은 5~2000자로 입력해 주세요');

  return { errors, value: { name, email, phone, company, type, message } };
}

// DB 행 → 텍스트 블록 (txt 내려받기용 포맷)
function formatInquiryBlock(row) {
  const line = '='.repeat(64);
  const indented = String(row.message).split(/\r?\n/).map((l) => `  ${l}`).join('\n');
  return [
    line,
    `[${String(row.id).padStart(4, '0')}] 접수일시: ${formatKST(new Date(row.created_at))} (KST)`,
    line,
    `이름      : ${row.name}`,
    `이메일    : ${row.email}`,
    `연락처    : ${row.phone || '-'}`,
    `회사/소속 : ${row.company || '-'}`,
    `문의유형  : ${row.type}`,
    '내용      :',
    indented,
    '',
    '',
  ].join('\n');
}

// ── Middleware ───────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// API 요청 전에 테이블을 보장한다 (lazy init)
app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('[db init]', err.message);
    res.status(500).json({ success: false, message: '데이터베이스 초기화에 실패했습니다' });
  }
});

// ── API routes ───────────────────────────────────────────────────

// 접수 현황 (문의 섹션의 "접수 현황" 카드)
app.get('/api/inquiries/stats', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM inquiries');
    res.json({ success: true, data: { count: rows[0].count, types: INQUIRY_TYPES } });
  } catch (err) {
    console.error('[stats]', err.message);
    res.status(500).json({ success: false, message: '접수 현황을 불러오지 못했습니다' });
  }
});

// 최근 문의 목록 (관리용 JSON)
app.get('/api/inquiries', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, phone, company, type, message, created_at
         FROM inquiries ORDER BY id DESC LIMIT $1`,
      [limit],
    );
    const data = rows.map((r) => ({
      no: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone || '',
      company: r.company || '',
      type: r.type,
      message: r.message,
      receivedAt: formatKST(new Date(r.created_at)),
    }));
    res.json({ success: true, data });
  } catch (err) {
    console.error('[list]', err.message);
    res.status(500).json({ success: false, message: '문의 목록을 불러오지 못했습니다' });
  }
});

// 전체 문의를 txt 로 내려받기 (DB 내용을 텍스트로 변환)
app.get('/api/inquiries/file', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, phone, company, type, message, created_at
         FROM inquiries ORDER BY id ASC`,
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '아직 접수된 문의가 없습니다' });
    }
    res.type('text/plain; charset=utf-8').send(rows.map(formatInquiryBlock).join(''));
  } catch (err) {
    console.error('[file]', err.message);
    res.status(500).json({ success: false, message: '문의 내역을 불러오지 못했습니다' });
  }
});

// 문의 접수 → DB 저장
app.post('/api/inquiries', async (req, res) => {
  const { errors, value } = validateInquiry(req.body || {});
  if (errors.length) {
    return res.status(400).json({ success: false, message: errors.join(' / ') });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO inquiries (name, email, phone, company, type, message)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [value.name, value.email, value.phone, value.company, value.type, value.message],
    );
    const { rows: countRows } = await pool.query('SELECT COUNT(*)::int AS count FROM inquiries');

    res.status(201).json({
      success: true,
      data: {
        no: rows[0].id,
        receivedAt: formatKST(new Date(rows[0].created_at)),
        savedTo: 'PostgreSQL · inquiries',
        count: countRows[0].count,
      },
    });
  } catch (err) {
    console.error('[create]', err.message);
    res.status(500).json({ success: false, message: '문의를 저장하지 못했습니다' });
  }
});

// ── SPA fallback (Express 5 문법) ────────────────────────────────

app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: '서버 내부 오류가 발생했습니다' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  if (!connectionString) {
    console.error('DATABASE_URL 이 설정되지 않았습니다. .env 파일을 확인해 주세요.');
    process.exit(1);
  }
  app.listen(PORT, async () => {
    console.log(`포켓몬 컴퍼니 홈페이지 서버 실행 중 → http://localhost:${PORT}`);
    try {
      await initDB();
      const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM inquiries');
      console.log(`DB 연결 OK · inquiries 테이블 ${rows[0].count}건`);
    } catch (err) {
      console.error('DB 연결 실패:', err.message);
    }
  });
}
module.exports = app;
