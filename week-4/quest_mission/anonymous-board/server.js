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
const PORT = process.env.PORT || 3008;

// ── Database ─────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
  max: 5,
});

// 유휴 커넥션이 끊겨도 프로세스가 죽지 않게 한다
pool.on('error', (err) => console.error('[pg] idle client error:', err.message));

const CATEGORIES = ['고민', '칭찬', '응원', '관심사', '기타'];

// 서버리스 cold start 마다 호출될 수 있으므로 한 번만 실행되도록 Promise 를 재사용한다
let dbReady = null;
function initDB() {
  if (!dbReady) {
    dbReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anon_posts (
          id         SERIAL PRIMARY KEY,
          category   TEXT NOT NULL,
          content    TEXT NOT NULL,
          likes      INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      // 같은 브라우저(voter_id)가 한 글에 공감을 여러 번 누르지 못하게 기록한다
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anon_likes (
          post_id    INTEGER NOT NULL REFERENCES anon_posts(id) ON DELETE CASCADE,
          voter_id   TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (post_id, voter_id)
        )
      `);
    })().catch((err) => {
      dbReady = null; // 실패하면 다음 요청에서 다시 시도
      throw err;
    });
  }
  return dbReady;
}

// 글 + (voterId 가 있으면) 내가 공감했는지 여부를 한 번에 가져온다
const POST_SELECT = `
  SELECT p.id, p.category, p.content, p.likes, p.created_at,
         (l.voter_id IS NOT NULL) AS liked
    FROM anon_posts p
    LEFT JOIN anon_likes l ON l.post_id = p.id AND l.voter_id = $1
`;

function toPost(row) {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    likes: row.likes,
    liked: row.liked,
    createdAt: row.created_at,
  };
}

async function findPost(id, voterId) {
  const { rows } = await pool.query(`${POST_SELECT} WHERE p.id = $2`, [voterId, id]);
  return rows[0] ? toPost(rows[0]) : null;
}

// ── Validation helpers ───────────────────────────────────────────

const VOTER_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const CONTENT_MAX = 500;
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

// 카테고리 목록
app.get('/api/categories', (_req, res) => {
  res.json({ success: true, data: CATEGORIES });
});

// 글 목록 (sort=latest | likes, category=선택)
app.get('/api/posts', async (req, res, next) => {
  try {
    const voterId = readVoterId(req.query.voterId);
    const category = CATEGORIES.includes(req.query.category) ? req.query.category : null;
    const orderBy = req.query.sort === 'likes'
      ? 'p.likes DESC, p.created_at DESC'
      : 'p.created_at DESC';

    const { rows } = await pool.query(
      `${POST_SELECT} WHERE ($2::text IS NULL OR p.category = $2) ORDER BY ${orderBy} LIMIT 200`,
      [voterId, category]
    );
    res.json({ success: true, data: rows.map(toPost) });
  } catch (err) {
    next(err);
  }
});

// 글 작성
app.post('/api/posts', async (req, res, next) => {
  try {
    const category = req.body?.category;
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';

    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, message: '카테고리를 선택해 주세요.' });
    }
    if (!content) {
      return res.status(400).json({ success: false, message: '내용을 입력해 주세요.' });
    }
    if (content.length > CONTENT_MAX) {
      return res.status(400).json({ success: false, message: `내용은 ${CONTENT_MAX}자 이내로 입력해 주세요.` });
    }

    const { rows } = await pool.query(
      `INSERT INTO anon_posts (category, content) VALUES ($1, $2)
       RETURNING id, category, content, likes, created_at, false AS liked`,
      [category, content]
    );
    res.status(201).json({ success: true, data: toPost(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// 공감 +1 (같은 voterId 로 다시 누르면 수가 늘지 않는다)
app.post('/api/posts/:id/like', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const voterId = readVoterId(req.body?.voterId);

    if (!id) {
      return res.status(404).json({ success: false, message: '글을 찾을 수 없습니다.' });
    }
    if (!voterId) {
      return res.status(400).json({ success: false, message: '올바르지 않은 참여자 정보입니다.' });
    }

    // 기록 INSERT 가 실제로 들어간 경우에만 likes 를 +1 한다 (한 문장이라 원자적)
    try {
      await pool.query(
        `WITH ins AS (
           INSERT INTO anon_likes (post_id, voter_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING
           RETURNING post_id
         )
         UPDATE anon_posts SET likes = likes + (SELECT COUNT(*) FROM ins)
          WHERE id = $1`,
        [id, voterId]
      );
    } catch (err) {
      if (err.code === '23503') {
        return res.status(404).json({ success: false, message: '글을 찾을 수 없습니다.' });
      }
      throw err;
    }

    res.json({ success: true, data: await findPost(id, voterId) });
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
  app
    .listen(PORT, () => console.log(`Anonymous board running on http://localhost:${PORT}`))
    .on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`포트 ${PORT} 이(가) 이미 사용 중입니다. 다른 포트로 실행하세요: PORT=3009 npm start`);
        process.exit(1);
      }
      throw err;
    });
}
module.exports = app;
