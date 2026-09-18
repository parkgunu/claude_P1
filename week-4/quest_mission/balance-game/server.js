const express = require('express');
const path = require('path');
const { Pool } = require('pg');

// 로컬에서는 같은 폴더의 .env 를 읽는다. Vercel 에서는 파일이 없으므로 대시보드 환경변수를 쓴다.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (_err) {
  // .env 가 없으면 무시
}

const app = express();
const PORT = process.env.PORT || 3007;

// ── Database ─────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
  max: 5,
});

// 유휴 커넥션이 끊겨도 프로세스가 죽지 않게 한다
pool.on('error', (err) => console.error('[pg] idle client error:', err.message));

const SEED_QUESTIONS = [
  ['직장인 최대 난제', '월급 500 + 주7일 출근', '월급 300 + 주4일 출근'],
  ['평생 하나만 먹는다면', '평생 라면 금지', '평생 치킨 금지'],
  ['초능력을 고른다면', '과거로 한 번 돌아가기', '미래를 한 번 엿보기'],
];

// 서버리스 cold start 마다 호출될 수 있으므로 한 번만 실행되도록 Promise 를 재사용한다
let dbReady = null;
function initDB() {
  if (!dbReady) {
    dbReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS bg_questions (
          id         SERIAL PRIMARY KEY,
          title      TEXT,
          option_a   TEXT NOT NULL,
          option_b   TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS bg_votes (
          id          SERIAL PRIMARY KEY,
          question_id INTEGER NOT NULL REFERENCES bg_questions(id) ON DELETE CASCADE,
          voter_id    TEXT NOT NULL,
          choice      CHAR(1) NOT NULL CHECK (choice IN ('A', 'B')),
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (question_id, voter_id)
        )
      `);

      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM bg_questions');
      if (rows[0].n === 0) {
        for (const [title, a, b] of SEED_QUESTIONS) {
          await pool.query(
            'INSERT INTO bg_questions (title, option_a, option_b) VALUES ($1, $2, $3)',
            [title, a, b]
          );
        }
      }
    })().catch((err) => {
      dbReady = null; // 실패하면 다음 요청에서 다시 시도
      throw err;
    });
  }
  return dbReady;
}

// 질문 + 집계 결과 + (voterId 가 있으면) 내 선택을 한 번에 가져온다
const QUESTION_SELECT = `
  SELECT q.id, q.title, q.option_a, q.option_b, q.created_at,
         COUNT(v.id) FILTER (WHERE v.choice = 'A')::int AS count_a,
         COUNT(v.id) FILTER (WHERE v.choice = 'B')::int AS count_b,
         MAX(v.choice) FILTER (WHERE v.voter_id = $1)   AS my_choice
    FROM bg_questions q
    LEFT JOIN bg_votes v ON v.question_id = q.id
`;

function toQuestion(row) {
  return {
    id: row.id,
    title: row.title,
    optionA: row.option_a,
    optionB: row.option_b,
    countA: row.count_a,
    countB: row.count_b,
    total: row.count_a + row.count_b,
    myChoice: row.my_choice || null,
    createdAt: row.created_at,
  };
}

async function findQuestion(id, voterId) {
  const { rows } = await pool.query(`${QUESTION_SELECT} WHERE q.id = $2 GROUP BY q.id`, [voterId, id]);
  return rows[0] ? toQuestion(rows[0]) : null;
}

// ── Validation helpers ───────────────────────────────────────────

const VOTER_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const cleanText = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
const parseId = (v) => (/^\d+$/.test(v) ? Number(v) : null);
const readVoterId = (v) => (typeof v === 'string' && VOTER_ID_RE.test(v) ? v : null);

// ── Middleware ───────────────────────────────────────────────────

app.use(express.json({ limit: '10kb' }));

app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('[db] init failed:', err.message);
    res.status(500).json({ success: false, message: '데이터베이스에 연결하지 못했습니다.' });
  }
});

// ── API routes ───────────────────────────────────────────────────

// 질문 목록 (sort=latest | popular)
app.get('/api/questions', async (req, res, next) => {
  try {
    const voterId = readVoterId(req.query.voterId);
    const orderBy = req.query.sort === 'popular'
      ? 'COUNT(v.id) DESC, q.created_at DESC'
      : 'q.created_at DESC';
    const { rows } = await pool.query(`${QUESTION_SELECT} GROUP BY q.id ORDER BY ${orderBy}`, [voterId]);
    res.json({ success: true, data: rows.map(toQuestion) });
  } catch (err) {
    next(err);
  }
});

// 질문 단건
app.get('/api/questions/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const question = id && (await findQuestion(id, readVoterId(req.query.voterId)));
    if (!question) {
      return res.status(404).json({ success: false, message: '질문을 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: question });
  } catch (err) {
    next(err);
  }
});

// 질문 등록
app.post('/api/questions', async (req, res, next) => {
  try {
    const title = cleanText(req.body?.title);
    const optionA = cleanText(req.body?.optionA);
    const optionB = cleanText(req.body?.optionB);

    if (!optionA || !optionB) {
      return res.status(400).json({ success: false, message: '두 선택지를 모두 입력해 주세요.' });
    }
    if (optionA.length > 60 || optionB.length > 60) {
      return res.status(400).json({ success: false, message: '선택지는 60자 이내로 입력해 주세요.' });
    }
    if (title.length > 40) {
      return res.status(400).json({ success: false, message: '제목은 40자 이내로 입력해 주세요.' });
    }
    if (optionA === optionB) {
      return res.status(400).json({ success: false, message: '두 선택지가 같으면 게임이 안 돼요.' });
    }

    const { rows } = await pool.query(
      'INSERT INTO bg_questions (title, option_a, option_b) VALUES ($1, $2, $3) RETURNING id',
      [title || null, optionA, optionB]
    );
    const question = await findQuestion(rows[0].id, null);
    res.status(201).json({ success: true, data: question });
  } catch (err) {
    next(err);
  }
});

// 투표 (같은 voterId 로 다시 투표하면 선택이 바뀐다)
app.post('/api/questions/:id/vote', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const voterId = readVoterId(req.body?.voterId);
    const choice = req.body?.choice;

    if (!id) {
      return res.status(404).json({ success: false, message: '질문을 찾을 수 없습니다.' });
    }
    if (!voterId) {
      return res.status(400).json({ success: false, message: '올바르지 않은 참여자 정보입니다.' });
    }
    if (choice !== 'A' && choice !== 'B') {
      return res.status(400).json({ success: false, message: 'choice 는 A 또는 B 여야 합니다.' });
    }

    try {
      await pool.query(
        `INSERT INTO bg_votes (question_id, voter_id, choice) VALUES ($1, $2, $3)
         ON CONFLICT (question_id, voter_id)
         DO UPDATE SET choice = EXCLUDED.choice, updated_at = now()`,
        [id, voterId, choice]
      );
    } catch (err) {
      if (err.code === '23503') {
        return res.status(404).json({ success: false, message: '질문을 찾을 수 없습니다.' });
      }
      throw err;
    }

    res.json({ success: true, data: await findQuestion(id, voterId) });
  } catch (err) {
    next(err);
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: 'API endpoint not found' });
});

// ── Static & SPA fallback ────────────────────────────────────────
// 폴더 전체를 static 으로 열면 server.js·.env 가 노출되므로 index.html 만 내보낸다.

app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => console.log(`Balance game running on http://localhost:${PORT}`));
}
module.exports = app;
