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
    CREATE TABLE IF NOT EXISTS todos (
      id         SERIAL PRIMARY KEY,
      title      TEXT NOT NULL,
      done       BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  dbInitialized = true;
}

// ── 헬퍼 ─────────────────────────────────────────────────────────

const MAX_TITLE = 200;

function parseTitle(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  if (!title) return { error: '할 일 내용을 입력해주세요.' };
  if (title.length > MAX_TITLE) return { error: `할 일은 ${MAX_TITLE}자 이하로 입력해주세요.` };
  return { title };
}

function parseId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ── 미들웨어 ─────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// /api 진입 시점에 테이블 존재를 보장한다.
app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('[initDB]', err.message);
    res.status(500).json({ success: false, message: '데이터베이스 초기화에 실패했습니다.' });
  }
});

// ── API: 조회 ────────────────────────────────────────────────────

// 미완료 먼저, 그 안에서 최신순
app.get('/api/todos', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, title, done, created_at FROM todos ORDER BY done ASC, created_at DESC'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// ── API: 생성 ────────────────────────────────────────────────────

app.post('/api/todos', async (req, res, next) => {
  try {
    const { title, error } = parseTitle(req.body);
    if (error) return res.status(400).json({ success: false, message: error });

    const { rows } = await pool.query(
      'INSERT INTO todos (title) VALUES ($1) RETURNING id, title, done, created_at',
      [title]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── API: 수정 ────────────────────────────────────────────────────

// title / done 중 보낸 필드만 부분 수정한다.
app.patch('/api/todos/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 id 입니다.' });

    const fields = [];
    const values = [];

    if (req.body?.title !== undefined) {
      const { title, error } = parseTitle(req.body);
      if (error) return res.status(400).json({ success: false, message: error });
      values.push(title);
      fields.push(`title = $${values.length}`);
    }

    if (req.body?.done !== undefined) {
      if (typeof req.body.done !== 'boolean') {
        return res.status(400).json({ success: false, message: 'done 은 true/false 여야 합니다.' });
      }
      values.push(req.body.done);
      fields.push(`done = $${values.length}`);
    }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: '수정할 항목이 없습니다.' });
    }

    values.push(id);
    const { rows } = await pool.query(
      `UPDATE todos SET ${fields.join(', ')} WHERE id = $${values.length}
       RETURNING id, title, done, created_at`,
      values
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '할 일을 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── API: 삭제 ────────────────────────────────────────────────────

// :id 라우트보다 먼저 등록해야 'completed' 가 id 로 잡히지 않는다.
app.delete('/api/todos/completed', async (_req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM todos WHERE done = true');
    res.json({ success: true, data: { deleted: rowCount } });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/todos/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 id 입니다.' });

    const { rows } = await pool.query('DELETE FROM todos WHERE id = $1 RETURNING id', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '할 일을 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: { id: rows[0].id } });
  } catch (err) {
    next(err);
  }
});

// 정의되지 않은 API 경로는 JSON 404 로 돌려준다 (SPA fallback 이 삼키지 않도록).
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: '존재하지 않는 API 경로입니다.' });
});

// ── SPA fallback (Express 5 문법) ────────────────────────────────

app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── 에러 핸들러 ──────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
});

// ── 시작 & export ────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
module.exports = app;
