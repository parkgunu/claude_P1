require('dotenv').config();

const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ── 설정 ─────────────────────────────────────────────────────────

const MAX_TITLE = 200;
const MAX_CONTENT = 10_000;
const MAX_QUERY = 100;

// ── DB 연결 ──────────────────────────────────────────────────────

// 접속 문자열은 .env 의 DATABASE_URL 로만 주입한다 (코드에 하드코딩 금지).
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false }, // Supabase 는 SSL 필수
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('[pg] idle client error:', err.message));

// 서버리스 cold start 마다 호출될 수 있으므로 flag 로 중복 실행을 막는다.
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memos (
      id         BIGSERIAL PRIMARY KEY,
      title      TEXT NOT NULL,
      content    TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  dbInitialized = true;
}

// ── 유틸 ─────────────────────────────────────────────────────────

const isValidId = (id) => /^\d{1,18}$/.test(String(id));

// ILIKE 패턴에서 %, _, \ 를 문자 그대로 검색하도록 이스케이프
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

// 제목/내용 검증 → { error } 또는 { title, content }
function parseMemoBody(body) {
  const { title, content } = body || {};
  if (typeof title !== 'string' || !title.trim()) {
    return { error: '제목을 입력해 주세요.' };
  }
  if (content !== undefined && typeof content !== 'string') {
    return { error: '내용은 문자열이어야 합니다.' };
  }
  if (title.trim().length > MAX_TITLE) {
    return { error: `제목은 ${MAX_TITLE}자 이하로 입력해 주세요.` };
  }
  if ((content || '').length > MAX_CONTENT) {
    return { error: `내용은 ${MAX_CONTENT.toLocaleString()}자 이하로 입력해 주세요.` };
  }
  return { title: title.trim(), content: content || '' };
}

// ── 미들웨어 ─────────────────────────────────────────────────────

app.use(express.json({ limit: '100kb' }));

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

// 메모 목록 (?q= 가 있으면 제목·내용에서 대소문자 무시 부분 검색)
app.get('/api/memos', async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, MAX_QUERY) : '';
    const { rows } = q
      ? await pool.query(
          `SELECT id, title, content, created_at FROM memos
            WHERE content ILIKE $1 OR title ILIKE $1
            ORDER BY created_at DESC, id DESC`,
          [`%${escapeLike(q)}%`]
        )
      : await pool.query(
          `SELECT id, title, content, created_at FROM memos ORDER BY created_at DESC, id DESC`
        );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

app.get('/api/memos/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: '잘못된 메모 ID입니다.' });
    }
    const { rows } = await pool.query(
      `SELECT id, title, content, created_at FROM memos WHERE id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: '메모를 찾을 수 없습니다.' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── API: POST ────────────────────────────────────────────────────

app.post('/api/memos', async (req, res, next) => {
  try {
    const parsed = parseMemoBody(req.body);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    const { rows } = await pool.query(
      `INSERT INTO memos (title, content) VALUES ($1, $2)
       RETURNING id, title, content, created_at`,
      [parsed.title, parsed.content]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── API: PUT ─────────────────────────────────────────────────────

app.put('/api/memos/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: '잘못된 메모 ID입니다.' });
    }
    const parsed = parseMemoBody(req.body);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    const { rows } = await pool.query(
      `UPDATE memos SET title = $1, content = $2 WHERE id = $3
       RETURNING id, title, content, created_at`,
      [parsed.title, parsed.content, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: '메모를 찾을 수 없습니다.' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── API: DELETE ──────────────────────────────────────────────────

app.delete('/api/memos/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: '잘못된 메모 ID입니다.' });
    }
    const { rows } = await pool.query(`DELETE FROM memos WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: '메모를 찾을 수 없습니다.' });
    res.json({ success: true, data: { id: rows[0].id } });
  } catch (err) {
    next(err);
  }
});

// ── API 404 & SPA fallback (Express 5 문법) ───────────────────────

app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: '존재하지 않는 API입니다.' });
});

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
  app.listen(PORT, () => console.log(`Memo server running on http://localhost:${PORT}`));
}
module.exports = app;
