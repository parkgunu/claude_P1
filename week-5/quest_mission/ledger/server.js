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
const PORT = process.env.PORT || 3011;

// ── Database ─────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
  max: 5,
});

// 유휴 커넥션이 끊겨도 프로세스가 죽지 않게 한다
pool.on('error', (err) => console.error('[pg] idle client error:', err.message));

// 기본 카테고리 (사용자가 직접 입력한 카테고리도 그대로 저장된다)
const DEFAULT_CATEGORIES = {
  expense: ['식비', '교통비', '관리비', '구독료', '경조사', '의료비', '쇼핑', '문화생활', '기타'],
  income: ['급여', '용돈', '부수입', '이자', '환급', '기타'],
};

// 서버리스 cold start 마다 호출될 수 있으므로 한 번만 실행되도록 Promise 를 재사용한다
let dbReady = null;
function initDB() {
  if (!dbReady) {
    dbReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS lg_entries (
          id         SERIAL PRIMARY KEY,
          type       TEXT   NOT NULL CHECK (type IN ('income', 'expense')),
          entry_date DATE   NOT NULL,
          amount     BIGINT NOT NULL CHECK (amount > 0),
          category   TEXT   NOT NULL,
          memo       TEXT   NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await pool.query(
        'CREATE INDEX IF NOT EXISTS lg_entries_date_idx ON lg_entries (entry_date DESC, id DESC)'
      );
    })().catch((err) => {
      dbReady = null; // 실패하면 다음 요청에서 다시 시도
      throw err;
    });
  }
  return dbReady;
}

// ── Middleware ───────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// /api 요청은 항상 DB 준비가 끝난 뒤에 처리한다
app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('[db init]', err.message);
    res.status(500).json({ success: false, message: 'DB 초기화에 실패했습니다: ' + err.message });
  }
});

// ── Helpers ──────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

// YYYY-MM 이 주어지면 [해당 월 1일, 다음 달 1일) 범위를 만든다
function monthRange(month) {
  if (!month) return null;
  if (!MONTH_RE.test(month)) return undefined; // 형식 오류
  const [y, m] = month.split('-').map(Number);
  if (m < 1 || m > 12) return undefined;
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  return {
    start: `${month}-01`,
    end: `${nextY}-${String(nextM).padStart(2, '0')}-01`,
  };
}

// 등록/수정 요청 body 를 검증하고 정규화한다
function parseEntry(body) {
  const { type, entryDate, amount, category, memo } = body || {};

  if (type !== 'income' && type !== 'expense') {
    return { error: '구분(type)은 income 또는 expense 여야 합니다.' };
  }
  if (typeof entryDate !== 'string' || !DATE_RE.test(entryDate)) {
    return { error: '날짜(entryDate)는 YYYY-MM-DD 형식이어야 합니다.' };
  }
  const amountNum = Number(amount);
  if (!Number.isInteger(amountNum) || amountNum <= 0) {
    return { error: '금액(amount)은 0보다 큰 정수여야 합니다.' };
  }
  if (amountNum > 1000000000000) {
    return { error: '금액(amount)이 너무 큽니다.' };
  }
  const categoryStr = typeof category === 'string' ? category.trim() : '';
  if (!categoryStr) {
    return { error: '카테고리(category)를 입력해 주세요.' };
  }
  if (categoryStr.length > 30) {
    return { error: '카테고리는 30자 이하로 입력해 주세요.' };
  }
  const memoStr = typeof memo === 'string' ? memo.trim().slice(0, 200) : '';

  return { value: { type, entryDate, amount: amountNum, category: categoryStr, memo: memoStr } };
}

// DB row → 클라이언트 응답 형태 (BIGINT 는 pg 가 문자열로 주므로 Number 로 변환)
function toEntry(row) {
  const date = row.entry_date;
  return {
    id: row.id,
    type: row.type,
    entryDate:
      date instanceof Date
        ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
            date.getDate()
          ).padStart(2, '0')}`
        : String(date).slice(0, 10),
    amount: Number(row.amount),
    category: row.category,
    memo: row.memo,
    createdAt: row.created_at,
  };
}

// ── API: 카테고리 목록 ───────────────────────────────────────────

// 기본 카테고리 + 지금까지 실제로 사용된 카테고리를 합쳐서 돌려준다
app.get('/api/categories', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT DISTINCT type, category FROM lg_entries ORDER BY type, category'
    );
    const data = {
      income: [...DEFAULT_CATEGORIES.income],
      expense: [...DEFAULT_CATEGORIES.expense],
    };
    for (const row of rows) {
      if (data[row.type] && !data[row.type].includes(row.category)) {
        data[row.type].push(row.category);
      }
    }
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// 내역이 존재하는 월 목록 (월 선택 드롭다운용)
app.get('/api/months', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT to_char(entry_date, 'YYYY-MM') AS month FROM lg_entries GROUP BY 1 ORDER BY 1 DESC"
    );
    res.json({ success: true, data: rows.map((r) => r.month) });
  } catch (err) {
    next(err);
  }
});

// ── API: 내역 목록 ───────────────────────────────────────────────

// GET /api/entries?month=YYYY-MM&type=income|expense&category=식비
app.get('/api/entries', async (req, res, next) => {
  try {
    const range = monthRange(req.query.month);
    if (range === undefined) {
      return res.status(400).json({ success: false, message: 'month 는 YYYY-MM 형식이어야 합니다.' });
    }

    const where = [];
    const params = [];
    if (range) {
      params.push(range.start, range.end);
      where.push(`entry_date >= $${params.length - 1} AND entry_date < $${params.length}`);
    }
    if (req.query.type === 'income' || req.query.type === 'expense') {
      params.push(req.query.type);
      where.push(`type = $${params.length}`);
    }
    if (req.query.category) {
      params.push(String(req.query.category));
      where.push(`category = $${params.length}`);
    }

    const { rows } = await pool.query(
      `SELECT id, type, entry_date, amount, category, memo, created_at
         FROM lg_entries
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY entry_date DESC, id DESC
        LIMIT 500`,
      params
    );
    res.json({ success: true, data: rows.map(toEntry) });
  } catch (err) {
    next(err);
  }
});

// ── API: 카테고리별 합계 ─────────────────────────────────────────

// GET /api/summary?month=YYYY-MM  → 총 수입/지출/잔액 + 카테고리별 합계
app.get('/api/summary', async (req, res, next) => {
  try {
    const range = monthRange(req.query.month);
    if (range === undefined) {
      return res.status(400).json({ success: false, message: 'month 는 YYYY-MM 형식이어야 합니다.' });
    }

    const params = [];
    let where = '';
    if (range) {
      params.push(range.start, range.end);
      where = 'WHERE entry_date >= $1 AND entry_date < $2';
    }

    const [totalsResult, byCategoryResult] = await Promise.all([
      pool.query(
        `SELECT type, COALESCE(SUM(amount), 0)::bigint AS total, COUNT(*)::int AS count
           FROM lg_entries ${where}
          GROUP BY type`,
        params
      ),
      pool.query(
        `SELECT type, category, SUM(amount)::bigint AS total, COUNT(*)::int AS count
           FROM lg_entries ${where}
          GROUP BY type, category
          ORDER BY SUM(amount) DESC`,
        params
      ),
    ]);

    const totals = { income: 0, expense: 0, incomeCount: 0, expenseCount: 0, net: 0 };
    for (const row of totalsResult.rows) {
      totals[row.type] = Number(row.total);
      totals[`${row.type}Count`] = row.count;
    }
    totals.net = totals.income - totals.expense;

    const byCategory = { income: [], expense: [] };
    for (const row of byCategoryResult.rows) {
      byCategory[row.type].push({
        category: row.category,
        total: Number(row.total),
        count: row.count,
      });
    }

    res.json({ success: true, data: { month: req.query.month || null, totals, byCategory } });
  } catch (err) {
    next(err);
  }
});

// ── API: 등록 / 수정 / 삭제 ──────────────────────────────────────

app.post('/api/entries', async (req, res, next) => {
  try {
    const { error, value } = parseEntry(req.body);
    if (error) return res.status(400).json({ success: false, message: error });

    const { rows } = await pool.query(
      `INSERT INTO lg_entries (type, entry_date, amount, category, memo)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, type, entry_date, amount, category, memo, created_at`,
      [value.type, value.entryDate, value.amount, value.category, value.memo]
    );
    res.status(201).json({ success: true, data: toEntry(rows[0]) });
  } catch (err) {
    next(err);
  }
});

app.put('/api/entries/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: '잘못된 id 입니다.' });
    }
    const { error, value } = parseEntry(req.body);
    if (error) return res.status(400).json({ success: false, message: error });

    const { rows } = await pool.query(
      `UPDATE lg_entries
          SET type = $1, entry_date = $2, amount = $3, category = $4, memo = $5
        WHERE id = $6
       RETURNING id, type, entry_date, amount, category, memo, created_at`,
      [value.type, value.entryDate, value.amount, value.category, value.memo, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '해당 내역을 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: toEntry(rows[0]) });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/entries/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: '잘못된 id 입니다.' });
    }
    const { rowCount } = await pool.query('DELETE FROM lg_entries WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: '해당 내역을 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: { id } });
  } catch (err) {
    next(err);
  }
});

// 정의되지 않은 API 경로는 SPA fallback 대신 JSON 404 로 답한다
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: '존재하지 않는 API 경로입니다.' });
});

// ── SPA fallback (Express 5 문법) ────────────────────────────────

app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => console.log(`가계부 서버 실행 중 → http://localhost:${PORT}`));
}
module.exports = app;
