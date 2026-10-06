const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const {
  hashPassword, verifyPassword, signToken,
  requireAuth, optionalAuth, secretProblem,
} = require('./auth');

// 로컬에서는 같은 폴더의 .env 를 읽는다. Vercel 에서는 파일이 없으므로 대시보드 환경변수를 쓴다.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (_err) {
  // .env 가 없으면 무시
}

const app = express();
const PORT = process.env.PORT || 3012;

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
      // 같은 사람이 한 글에 공감을 여러 번 누르지 못하게 기록한다.
      // voter_id 는 로그인 기능 이전에 쓰던 브라우저 식별자 (PK 라 계속 채워 넣는다).
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anon_likes (
          post_id    INTEGER NOT NULL REFERENCES anon_posts(id) ON DELETE CASCADE,
          voter_id   TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (post_id, voter_id)
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS anon_users (
          id            SERIAL PRIMARY KEY,
          email         TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          nickname      TEXT NOT NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      // 글쓴이는 화면에 절대 드러내지 않고, 오직 "내 글" 판별·삭제에만 쓴다.
      // 로그인 기능 이전 글은 user_id 가 NULL 로 남아 누구의 것도 아니게 된다.
      await pool.query(
        `ALTER TABLE anon_posts ADD COLUMN IF NOT EXISTS
           user_id INTEGER REFERENCES anon_users(id) ON DELETE SET NULL`
      );
      await pool.query('CREATE INDEX IF NOT EXISTS anon_posts_user_id_idx ON anon_posts (user_id)');
      // 공감 중복 판정을 브라우저가 아니라 계정 기준으로 바꾼다
      await pool.query(
        `ALTER TABLE anon_likes ADD COLUMN IF NOT EXISTS
           user_id INTEGER REFERENCES anon_users(id) ON DELETE CASCADE`
      );
      // user_id 가 NULL 인 옛 기록끼리는 서로 충돌하지 않는다 (PG 는 NULL 을 다 다르게 본다)
      await pool.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS anon_likes_post_user_idx ON anon_likes (post_id, user_id)'
      );
    })().catch((err) => {
      dbReady = null; // 실패하면 다음 요청에서 다시 시도
      throw err;
    });
  }
  return dbReady;
}

// 글 + (로그인했으면) 내가 공감했는지·내가 쓴 글인지를 한 번에 가져온다.
// $1 은 보는 사람의 user_id (비로그인이면 NULL) — 다른 사람의 글쓴이 정보는 내보내지 않는다.
const POST_SELECT = `
  SELECT p.id, p.category, p.content, p.likes, p.created_at,
         (l.user_id IS NOT NULL) AS liked,
         COALESCE(p.user_id = $1::int, false) AS mine
    FROM anon_posts p
    LEFT JOIN anon_likes l ON l.post_id = p.id AND l.user_id = $1::int
`;

function toPost(row) {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    likes: row.likes,
    liked: row.liked,
    mine: row.mine,
    createdAt: row.created_at,
  };
}

async function findPost(id, userId) {
  const { rows } = await pool.query(`${POST_SELECT} WHERE p.id = $2`, [userId ?? null, id]);
  return rows[0] ? toPost(rows[0]) : null;
}

// ── Validation helpers ───────────────────────────────────────────

const CONTENT_MAX = 500;
const LIMITS = { email: 120, password: 72, nickname: 20 };
// 로컬파트@도메인.tld 정도만 본다 (진짜 확인은 어차피 메일 발송으로만 가능하다)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const parseId = (v) => (/^\d+$/.test(v) ? Number(v) : null);
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const badRequest = (res, message) => res.status(400).json({ success: false, message });

const toUser = (row) => ({ id: row.id, email: row.email, nickname: row.nickname, createdAt: row.created_at });

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

// ── API routes: 인증 ─────────────────────────────────────────────
// 닉네임은 로그인한 본인 화면(헤더)에만 쓰고, 게시글에는 절대 붙이지 않는다.

// 회원가입 → 바로 로그인된 상태로 토큰을 내려준다
app.post('/api/auth/signup', async (req, res, next) => {
  try {
    const email = str(req.body?.email).toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const nickname = str(req.body?.nickname);

    if (!EMAIL_RE.test(email)) return badRequest(res, '이메일 형식이 올바르지 않습니다.');
    if (email.length > LIMITS.email) return badRequest(res, `이메일은 ${LIMITS.email}자 이내로 입력해 주세요.`);
    if (!nickname) return badRequest(res, '닉네임을 입력해 주세요.');
    if (nickname.length > LIMITS.nickname) return badRequest(res, `닉네임은 ${LIMITS.nickname}자 이내로 입력해 주세요.`);
    if (password.length < 8) return badRequest(res, '비밀번호는 8자 이상이어야 합니다.');
    // bcrypt 는 72바이트를 넘으면 뒤를 잘라 버리므로 미리 막는다
    if (Buffer.byteLength(password) > LIMITS.password) return badRequest(res, '비밀번호가 너무 깁니다.');

    const passwordHash = await hashPassword(password);

    let user;
    try {
      const { rows } = await pool.query(
        `INSERT INTO anon_users (email, password_hash, nickname) VALUES ($1, $2, $3)
         RETURNING id, email, nickname, created_at`,
        [email, passwordHash, nickname]
      );
      user = rows[0];
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ success: false, message: '이미 가입된 이메일입니다.' });
      throw err;
    }

    res.status(201).json({ success: true, data: { token: signToken(user), user: toUser(user) } });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    next(err);
  }
});

// 로그인
app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = str(req.body?.email).toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password) return badRequest(res, '이메일과 비밀번호를 입력해 주세요.');

    const { rows } = await pool.query(
      'SELECT id, email, nickname, password_hash, created_at FROM anon_users WHERE email = $1',
      [email]
    );
    const user = rows[0];
    // 어느 쪽이 틀렸는지 알려 주면 가입된 이메일을 찾아낼 수 있으므로 같은 문구를 쓴다
    const ok = user && (await verifyPassword(password, user.password_hash));
    if (!ok) {
      return res.status(401).json({ success: false, message: '이메일 또는 비밀번호가 올바르지 않습니다.' });
    }

    res.json({ success: true, data: { token: signToken(user), user: toUser(user) } });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    next(err);
  }
});

// 저장해 둔 토큰이 아직 쓸 수 있는지 확인 (새로고침할 때마다 부른다)
app.get('/api/auth/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, nickname, created_at FROM anon_users WHERE id = $1',
      [req.userId]
    );
    if (!rows[0]) return res.status(401).json({ success: false, message: '탈퇴했거나 없는 계정입니다.' });
    res.json({ success: true, data: { user: toUser(rows[0]) } });
  } catch (err) {
    next(err);
  }
});

// 글 목록 (sort=latest | likes, category=선택, mine=1 이면 내가 쓴 글만)
// 로그인하지 않아도 읽을 수 있다 — 토큰이 있으면 liked·mine 표시가 같이 붙는다.
app.get('/api/posts', optionalAuth, async (req, res, next) => {
  try {
    const userId = req.userId ?? null;
    const mineOnly = req.query.mine === '1';
    const category = CATEGORIES.includes(req.query.category) ? req.query.category : null;
    const orderBy = req.query.sort === 'likes'
      ? 'p.likes DESC, p.created_at DESC'
      : 'p.created_at DESC';

    if (mineOnly && !userId) {
      return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
    }

    const { rows } = await pool.query(
      `${POST_SELECT}
        WHERE ($2::text IS NULL OR p.category = $2)
          AND ($3::boolean IS NOT TRUE OR p.user_id = $1::int)
        ORDER BY ${orderBy} LIMIT 200`,
      [userId, category, mineOnly]
    );
    res.json({ success: true, data: rows.map(toPost) });
  } catch (err) {
    next(err);
  }
});

// ── 여기서부터 쓰기 동작은 로그인한 사용자만 ─────────────────────
// (글쓴이는 저장만 하고 화면·응답 어디에도 드러내지 않는다)

// 글 작성
app.post('/api/posts', requireAuth, async (req, res, next) => {
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
      `INSERT INTO anon_posts (category, content, user_id) VALUES ($1, $2, $3)
       RETURNING id, category, content, likes, created_at, false AS liked, true AS mine`,
      [category, content, req.userId]
    );
    res.status(201).json({ success: true, data: toPost(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// 내 글 삭제 (남의 글은 지울 수 없다)
app.delete('/api/posts/:id', requireAuth, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ success: false, message: '글을 찾을 수 없습니다.' });

    const { rows } = await pool.query('SELECT user_id FROM anon_posts WHERE id = $1', [id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: '글을 찾을 수 없습니다.' });
    if (rows[0].user_id !== req.userId) {
      return res.status(403).json({ success: false, message: '내가 쓴 글만 삭제할 수 있습니다.' });
    }

    // 공감 기록은 anon_likes 의 ON DELETE CASCADE 로 같이 지워진다
    await pool.query('DELETE FROM anon_posts WHERE id = $1 AND user_id = $2', [id, req.userId]);
    res.json({ success: true, data: { id } });
  } catch (err) {
    next(err);
  }
});

// 공감 +1 (같은 계정으로 다시 누르면 수가 늘지 않는다 — 다른 브라우저에서 눌러도 마찬가지)
app.post('/api/posts/:id/like', requireAuth, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(404).json({ success: false, message: '글을 찾을 수 없습니다.' });
    }

    // 기록 INSERT 가 실제로 들어간 경우에만 likes 를 +1 한다 (한 문장이라 원자적).
    // voter_id 는 기존 PK 를 채우기 위한 값이고, 실제 중복 판정은 user_id 쪽 unique index 가 한다.
    try {
      await pool.query(
        `WITH ins AS (
           INSERT INTO anon_likes (post_id, voter_id, user_id) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING
           RETURNING post_id
         )
         UPDATE anon_posts SET likes = likes + (SELECT COUNT(*) FROM ins)
          WHERE id = $1`,
        [id, `u${req.userId}`, req.userId]
      );
    } catch (err) {
      if (err.code === '23503') {
        return res.status(404).json({ success: false, message: '글을 찾을 수 없습니다.' });
      }
      throw err;
    }

    const post = await findPost(id, req.userId);
    if (!post) return res.status(404).json({ success: false, message: '글을 찾을 수 없습니다.' });
    res.json({ success: true, data: post });
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
  // 키가 없으면 로그인·가입이 503 으로 막히므로 뜰 때 한 번 알려 준다
  const problem = secretProblem();
  if (problem) console.warn(`⚠️  ${problem}`);

  app
    .listen(PORT, () => console.log(`Anonymous board running on http://localhost:${PORT}`))
    .on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`포트 ${PORT} 이(가) 이미 사용 중입니다. 다른 포트로 실행하세요: PORT=3013 npm start`);
        process.exit(1);
      }
      throw err;
    });
}
module.exports = app;
