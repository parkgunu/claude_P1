require('dotenv').config();

const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3014;

// ── 설정 ─────────────────────────────────────────────────────────

const UPBIT_BASE = 'https://api.upbit.com/v1';
const INITIAL_CASH = 10_000_000;   // 최초 지갑 현금(원)
const MIN_ORDER_KRW = 5_000;       // 업비트 KRW 마켓 최소 주문금액
const MARKET_CACHE_MS = 60 * 60 * 1000; // 마켓 목록(한글명)은 자주 안 바뀐다
const MAX_MEMO = 200;
const CANDLE_MINUTES = [1, 3, 5, 10, 15, 30, 60, 240]; // 업비트 분봉 단위

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
// wallet: 자산(currency)별 1행. KRW 행은 현금, 나머지는 코인 보유량 + 평균매수가.
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet (
      currency      TEXT PRIMARY KEY,
      balance       NUMERIC(30, 8) NOT NULL DEFAULT 0 CHECK (balance >= 0),
      avg_buy_price NUMERIC(30, 8) NOT NULL DEFAULT 0,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id         BIGSERIAL PRIMARY KEY,
      ordered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      market     TEXT NOT NULL,
      side       TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
      volume     NUMERIC(30, 8) NOT NULL CHECK (volume > 0),
      price      NUMERIC(30, 8) NOT NULL CHECK (price > 0),
      amount     NUMERIC(20, 0) NOT NULL,
      memo       TEXT
    )
  `);
  await pool.query(
    `INSERT INTO wallet (currency, balance) VALUES ('KRW', $1) ON CONFLICT (currency) DO NOTHING`,
    [INITIAL_CASH]
  );
  dbInitialized = true;
}

// ── 업비트 시세 ──────────────────────────────────────────────────

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function upbitGet(pathname) {
  const res = await fetch(`${UPBIT_BASE}${pathname}`, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new HttpError(502, res.status === 429
      ? '업비트 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.'
      : `업비트 시세를 불러오지 못했습니다. (HTTP ${res.status})`);
  }
  return res.json();
}

// 캐시 + 진행 중 요청 공유 (동시 요청이 와도 업비트는 한 번만 호출)
function cached(ttl, loader) {
  let value = null;
  let expires = 0;
  let pending = null;
  return async () => {
    if (value && Date.now() < expires) return value;
    if (!pending) {
      pending = loader()
        .then((v) => { value = v; expires = Date.now() + ttl; return v; })
        .finally(() => { pending = null; });
    }
    return pending;
  };
}

// KRW 마켓 목록 → Map<market, { korean_name, english_name, warning }>
const getMarkets = cached(MARKET_CACHE_MS, async () => {
  const list = await upbitGet('/market/all?isDetails=true');
  return new Map(
    list
      .filter((m) => m.market.startsWith('KRW-'))
      .map((m) => [m.market, {
        korean_name: m.korean_name,
        english_name: m.english_name,
        warning: Boolean(m.market_event?.warning),
      }])
  );
});

// 화면용 시세 프록시 (GET /api/upbit/...) 가 허용하는 업비트 경로 → 캐시 시간(ms)
// 브라우저가 업비트를 직접 부르면 Origin 헤더 때문에 "10초에 1회" 제한에 걸려 429 가 난다.
// 서버를 거치면 Origin 이 없어 초당 10회까지 되고, 캐시로 동시 접속자 요청도 한 번으로 합친다.
const UPBIT_PROXY = {
  '/market/all': MARKET_CACHE_MS,
  '/ticker/all': 1000,
  '/candles/minutes/60': 5000,
};
const proxyCache = new Map(); // url → cached loader

function upbitProxied(url, ttl) {
  if (!proxyCache.has(url)) {
    if (proxyCache.size > 500) proxyCache.clear(); // 종목별 캔들 키가 무한히 쌓이지 않게
    proxyCache.set(url, cached(ttl, () => upbitGet(url)));
  }
  return proxyCache.get(url)();
}

// 체결가는 클라이언트 값을 믿지 않고 주문 시점에 서버가 직접 조회한다
async function getLivePrice(market) {
  const [t] = await upbitGet(`/ticker?markets=${encodeURIComponent(market)}`);
  if (!t || typeof t.trade_price !== 'number') throw new HttpError(502, '현재가를 확인하지 못했습니다.');
  return t.trade_price;
}

// ── 헬퍼 ─────────────────────────────────────────────────────────

// 0.01046342 * 1e8 = 1046341.9999… 같은 부동소수점 오차로 1사토시가 깎이지 않도록 보정값을 더한다
const floor8 = (n) => Math.floor(n * 1e8 + 1e-6) / 1e8;
const won = (n) => Math.round(n).toLocaleString('ko-KR');
const num = (v) => (v === null || v === undefined ? 0 : Number(v));

function parsePositive(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

// 주문 body 검증 → { market, side, volume?, amount?, memo } 또는 { error }
function parseOrder(body, markets) {
  const market = typeof body?.market === 'string' ? body.market.trim().toUpperCase() : '';
  const side = body?.side;
  const memo = typeof body?.memo === 'string' ? body.memo.trim() : '';
  const volume = parsePositive(body?.volume);
  const amount = parsePositive(body?.amount);

  if (!markets.has(market)) return { error: '존재하지 않는 KRW 마켓입니다.' };
  if (side !== 'buy' && side !== 'sell') return { error: "side 는 'buy' 또는 'sell' 이어야 합니다." };
  if (Number.isNaN(volume) || Number.isNaN(amount)) return { error: '수량과 금액은 0보다 큰 숫자여야 합니다.' };
  if ((volume === null) === (amount === null)) return { error: '수량(volume) 또는 금액(amount) 중 하나만 입력해 주세요.' };
  if (memo.length > MAX_MEMO) return { error: `메모는 ${MAX_MEMO}자 이하로 입력해 주세요.` };

  return { market, side, volume, amount, memo: memo || null };
}

function formatOrder(row) {
  return {
    id: Number(row.id),
    ordered_at: row.ordered_at,
    market: row.market,
    side: row.side,
    volume: num(row.volume),
    price: num(row.price),
    amount: num(row.amount),
    memo: row.memo,
  };
}

// ── 미들웨어 ─────────────────────────────────────────────────────

app.use(express.json());

// index.html 을 파일로 직접 열거나 Live Server(5500 포트 등)로 열어도 API 를 호출할 수 있게 CORS 허용
app.use('/api', (req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// .env · server.js 가 노출되지 않도록 폴더 전체가 아닌 index.html 만 서빙한다
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// 화면용 업비트 시세 프록시. DB 가 필요 없으므로 initDB 앞에 둔다.
// 응답은 업비트 JSON 그대로 (success/data 로 감싸지 않는다).
app.get('/api/upbit/{*splat}', async (req, res, next) => {
  try {
    const pathname = req.path.replace(/^\/api\/upbit/, '');
    const ttl = UPBIT_PROXY[pathname];
    if (!ttl) return res.status(404).json({ success: false, message: 'API endpoint not found' });
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    res.json(await upbitProxied(`${pathname}${query}`, ttl));
  } catch (err) {
    next(err);
  }
});

app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('[initDB]', err.message);
    res.status(500).json({ success: false, message: '데이터베이스 초기화에 실패했습니다.' });
  }
});

// ── API: 시세 조회 ───────────────────────────────────────────────

// GET /api/price?market=KRW-BTC&unit=days&count=30
// 현재가 + 캔들. unit: days | weeks | minutes-N (N = 1,3,5,10,15,30,60,240)
app.get('/api/price', async (req, res, next) => {
  try {
    const market = String(req.query.market || 'KRW-BTC').trim().toUpperCase();
    const unit = String(req.query.unit || 'days').trim().toLowerCase();
    const count = Math.min(Math.max(parseInt(req.query.count, 10) || 30, 1), 200);

    const info = (await getMarkets()).get(market);
    if (!info) return res.status(400).json({ success: false, message: '존재하지 않는 KRW 마켓입니다.' });

    const minutes = unit.match(/^minutes-(\d+)$/);
    let candlePath;
    if (unit === 'days' || unit === 'weeks') candlePath = unit;
    else if (minutes && CANDLE_MINUTES.includes(Number(minutes[1]))) candlePath = `minutes/${minutes[1]}`;
    else return res.status(400).json({ success: false, message: `unit 은 days, weeks, minutes-N (N: ${CANDLE_MINUTES.join(', ')}) 중 하나여야 합니다.` });

    const q = encodeURIComponent(market);
    const [[t], candles] = await Promise.all([
      upbitGet(`/ticker?markets=${q}`),
      upbitGet(`/candles/${candlePath}?market=${q}&count=${count}`),
    ]);

    res.json({
      success: true,
      data: {
        market,
        korean_name: info.korean_name,
        warning: info.warning,
        price: t.trade_price,
        change_rate: t.signed_change_rate,          // 전일 대비 (0.0123 = +1.23%)
        high_price: t.high_price,
        low_price: t.low_price,
        acc_trade_price_24h: t.acc_trade_price_24h, // 24시간 거래대금(원)
        unit,
        // 최신 캔들이 맨 앞
        candles: candles.map((c) => ({
          time: c.candle_date_time_kst,
          open: c.opening_price,
          high: c.high_price,
          low: c.low_price,
          close: c.trade_price,
          volume: c.candle_acc_trade_volume,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── API: 지갑 · 주문 조회 ────────────────────────────────────────

// 현금 + 보유 코인(수량 > 0). 평가액/수익률은 실시간 시세를 가진 프론트에서 계산한다.
app.get('/api/wallet', async (_req, res, next) => {
  try {
    const [{ rows }, markets] = await Promise.all([
      pool.query('SELECT currency, balance, avg_buy_price FROM wallet ORDER BY currency'),
      getMarkets(),
    ]);
    const cash = num(rows.find((r) => r.currency === 'KRW')?.balance);
    const holdings = rows
      .filter((r) => r.currency !== 'KRW' && num(r.balance) > 0)
      .map((r) => {
        const market = `KRW-${r.currency}`;
        return {
          currency: r.currency,
          market,
          korean_name: markets.get(market)?.korean_name || r.currency,
          balance: num(r.balance),
          avg_buy_price: num(r.avg_buy_price),
        };
      });
    res.json({ success: true, data: { cash, holdings } });
  } catch (err) {
    next(err);
  }
});

app.get('/api/orders', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 200);
    const { rows } = await pool.query(
      'SELECT id, ordered_at, market, side, volume, price, amount, memo FROM orders ORDER BY id DESC LIMIT $1',
      [limit]
    );
    res.json({ success: true, data: rows.map(formatOrder) });
  } catch (err) {
    next(err);
  }
});

// ── API: 매수 / 매도 ─────────────────────────────────────────────

// body: { market: 'KRW-BTC', side: 'buy'|'sell', volume?: 코인수량, amount?: 원화금액, memo?: string }
// 현재가(시장가)로 즉시 체결. 잔고 차감은 조건부 UPDATE(balance >= 필요량)로 처리해
// 동시 주문이 들어와도 음수 잔고가 생기지 않는다.
// 화면은 /api/orders, 투자 에이전트는 /api/order 로 호출한다 (같은 핸들러).
app.post(['/api/order', '/api/orders'], async (req, res, next) => {
  let client;
  try {
    const parsed = parseOrder(req.body, await getMarkets());
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });

    const { market, side, memo } = parsed;
    const currency = market.replace('KRW-', '');
    const price = await getLivePrice(market);

    // 금액 주문이면 체결가 기준으로 수량 환산 (소수점 8자리 버림 → 금액을 넘지 않음)
    const volume = parsed.volume !== null ? floor8(parsed.volume) : floor8(parsed.amount / price);
    const amount = Math.round(volume * price);

    if (volume <= 0 || amount < MIN_ORDER_KRW) {
      return res.status(400).json({
        success: false,
        message: `최소 주문금액은 ${won(MIN_ORDER_KRW)}원입니다. (현재 주문 ${won(amount)}원)`,
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    if (side === 'buy') {
      const paid = await client.query(
        `UPDATE wallet SET balance = balance - $1, updated_at = now()
          WHERE currency = 'KRW' AND balance >= $1 RETURNING balance`,
        [amount]
      );
      if (paid.rowCount === 0) {
        await client.query('ROLLBACK');
        const { rows } = await pool.query(`SELECT balance FROM wallet WHERE currency = 'KRW'`);
        return res.status(400).json({
          success: false,
          message: `현금이 부족합니다. (보유 ${won(num(rows[0]?.balance))}원 / 필요 ${won(amount)}원)`,
        });
      }
      // 평균매수가 = (기존수량×기존평단 + 매수수량×체결가) / 합계수량
      await client.query(
        `INSERT INTO wallet (currency, balance, avg_buy_price) VALUES ($1, $2, $3)
         ON CONFLICT (currency) DO UPDATE SET
           avg_buy_price = (wallet.balance * wallet.avg_buy_price + EXCLUDED.balance * EXCLUDED.avg_buy_price)
                           / (wallet.balance + EXCLUDED.balance),
           balance = wallet.balance + EXCLUDED.balance,
           updated_at = now()`,
        [currency, volume, price]
      );
    } else {
      const sold = await client.query(
        `UPDATE wallet SET
           balance = balance - $2,
           avg_buy_price = CASE WHEN balance - $2 = 0 THEN 0 ELSE avg_buy_price END,
           updated_at = now()
          WHERE currency = $1 AND balance >= $2 RETURNING balance`,
        [currency, volume]
      );
      if (sold.rowCount === 0) {
        await client.query('ROLLBACK');
        const { rows } = await pool.query('SELECT balance FROM wallet WHERE currency = $1', [currency]);
        return res.status(400).json({
          success: false,
          message: `보유 수량이 부족합니다. (보유 ${num(rows[0]?.balance)} ${currency} / 매도 ${volume} ${currency})`,
        });
      }
      await client.query(
        `UPDATE wallet SET balance = balance + $1, updated_at = now() WHERE currency = 'KRW'`,
        [amount]
      );
    }

    const { rows } = await client.query(
      `INSERT INTO orders (market, side, volume, price, amount, memo) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, ordered_at, market, side, volume, price, amount, memo`,
      [market, side, volume, price, amount, memo]
    );
    await client.query('COMMIT');

    res.status(201).json({ success: true, data: formatOrder(rows[0]) });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    if (client) client.release();
  }
});

// ── 없는 API · SPA fallback ──────────────────────────────────────

app.all('/api/{*splat}', (_req, res) => {
  res.status(404).json({ success: false, message: 'API endpoint not found' });
});

app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── 에러 핸들러 ──────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ success: false, message: err.message });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: '요청 본문이 올바른 JSON 이 아닙니다.' });
  }
  console.error(err);
  res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
module.exports = app;
