// OFFDAY 쇼핑몰 서버
// 상품 목록은 누구나, 장바구니/주문은 로그인한 사용자만.
// 정적 파일(index.html) 서빙 + /api REST 엔드포인트를 한 파일에서 처리한다.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PRODUCTS, CATEGORIES } = require('./seed-data');

// 로컬에서는 같은 폴더의 .env 를 읽는다. Vercel 에서는 파일이 없으므로 대시보드 환경변수를 쓴다.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (_err) {
  // .env 가 없으면 무시
}

const app = express();
const PORT = process.env.PORT || 3013;

// ── Database ─────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
  max: 5,
});

// 유휴 커넥션이 끊겨도 프로세스가 죽지 않게 한다
pool.on('error', (err) => console.error('[pg] idle client error:', err.message));

// 서버리스 cold start 마다 호출될 수 있으므로 한 번만 실행되도록 Promise 를 재사용한다
let dbReady = null;
function initDB() {
  if (!dbReady) {
    dbReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sh_users (
          id            SERIAL PRIMARY KEY,
          email         TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          name          TEXT NOT NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sh_products (
          id           SERIAL PRIMARY KEY,
          slug         TEXT NOT NULL UNIQUE,
          name         TEXT NOT NULL,
          brand        TEXT NOT NULL,
          category     TEXT NOT NULL,
          price        INTEGER NOT NULL CHECK (price >= 0),
          list_price   INTEGER NOT NULL CHECK (list_price >= 0),
          image        TEXT NOT NULL,
          description  TEXT NOT NULL DEFAULT '',
          badge        TEXT NOT NULL DEFAULT '',
          rating       NUMERIC(2,1) NOT NULL DEFAULT 0,
          review_count INTEGER NOT NULL DEFAULT 0,
          stock        INTEGER NOT NULL DEFAULT 0,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sh_cart_items (
          id         SERIAL PRIMARY KEY,
          user_id    INTEGER NOT NULL REFERENCES sh_users(id)    ON DELETE CASCADE,
          product_id INTEGER NOT NULL REFERENCES sh_products(id) ON DELETE CASCADE,
          qty        INTEGER NOT NULL CHECK (qty > 0),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (user_id, product_id)
        )
      `);
      // user_id 가 비어 있으면 비회원 주문이다
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sh_orders (
          id               SERIAL PRIMARY KEY,
          user_id          INTEGER REFERENCES sh_users(id) ON DELETE CASCADE,
          order_no         TEXT NOT NULL UNIQUE,
          total            BIGINT NOT NULL,
          buyer_name       TEXT NOT NULL DEFAULT '',
          buyer_phone      TEXT NOT NULL DEFAULT '',
          buyer_email      TEXT NOT NULL DEFAULT '',
          shipping_address TEXT NOT NULL DEFAULT '',
          created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      // 이미 만들어진 테이블을 비회원 주문까지 받도록 맞춘다 (여러 번 실행해도 안전하다)
      await pool.query('ALTER TABLE sh_orders ALTER COLUMN user_id DROP NOT NULL');
      for (const col of ['buyer_name', 'buyer_phone', 'buyer_email', 'shipping_address']) {
        await pool.query(`ALTER TABLE sh_orders ADD COLUMN IF NOT EXISTS ${col} TEXT NOT NULL DEFAULT ''`);
      }
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sh_order_items (
          id         SERIAL PRIMARY KEY,
          order_id   INTEGER NOT NULL REFERENCES sh_orders(id) ON DELETE CASCADE,
          product_id INTEGER REFERENCES sh_products(id) ON DELETE SET NULL,
          name       TEXT NOT NULL,
          brand      TEXT NOT NULL DEFAULT '',
          image      TEXT NOT NULL DEFAULT '',
          price      INTEGER NOT NULL,
          qty        INTEGER NOT NULL
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS sh_cart_user_idx  ON sh_cart_items (user_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS sh_orders_user_idx ON sh_orders (user_id, created_at DESC)');
      await seedProducts();
    })().catch((err) => {
      dbReady = null; // 실패하면 다음 요청에서 다시 시도
      throw err;
    });
  }
  return dbReady;
}

// 상품은 slug 기준으로 한 번만 넣는다. 이미 있으면 건드리지 않아 재실행해도 안전하다.
async function seedProducts() {
  const values = [];
  const rows = PRODUCTS.map((p, i) => {
    const b = i * 12;
    values.push(p.slug, p.name, p.brand, p.category, p.price, p.list_price,
      p.image, p.description, p.badge || '', p.rating, p.review_count, p.stock);
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12})`;
  });
  const res = await pool.query(
    `INSERT INTO sh_products
       (slug, name, brand, category, price, list_price, image, description, badge, rating, review_count, stock)
     VALUES ${rows.join(',')}
     ON CONFLICT (slug) DO NOTHING`,
    values
  );
  if (res.rowCount > 0) console.log(`[seed] 상품 ${res.rowCount}개를 새로 넣었습니다.`);
}

// ── Auth ─────────────────────────────────────────────────────────

const TOKEN_TTL = '7d';
const BCRYPT_ROUNDS = 10;
const MIN_SECRET_LENGTH = 32;

// 비밀키가 약하면 토큰을 위조할 수 있으므로, 없는 채로는 인증을 처리하지 않는다
function getSecret() {
  const secret = (process.env.JWT_SECRET || '').trim();
  if (secret.length < MIN_SECRET_LENGTH) {
    const err = new Error('서버에 JWT_SECRET 이 설정되지 않았습니다.');
    err.status = 503;
    throw err;
  }
  return secret;
}

function secretProblem() {
  try {
    getSecret();
    return null;
  } catch (_err) {
    return `JWT_SECRET 이 없거나 너무 짧습니다(${MIN_SECRET_LENGTH}자 이상 필요). .env 에 추가해 주세요.\n    만들기: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;
  }
}

const signToken = (user) =>
  jwt.sign({ sub: String(user.id), email: user.email }, getSecret(), { expiresIn: TOKEN_TTL });

// Authorization 헤더에서 Bearer 토큰만 꺼낸다
function readBearer(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  return scheme && scheme.toLowerCase() === 'bearer' && token ? token.trim() : null;
}

// 토큰이 유효하면 req.userId 를 채우고, 아니면 401 로 끊는다
function requireAuth(req, res, next) {
  const token = readBearer(req);
  if (!token) {
    return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
  }

  let payload;
  try {
    payload = jwt.verify(token, getSecret());
  } catch (err) {
    if (err.status === 503) {
      return res.status(503).json({ success: false, message: err.message });
    }
    const expired = err instanceof jwt.TokenExpiredError;
    return res.status(401).json({
      success: false,
      message: expired ? '로그인이 만료되었습니다. 다시 로그인해 주세요.' : '로그인 정보가 올바르지 않습니다.',
    });
  }

  const userId = Number(payload.sub);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(401).json({ success: false, message: '로그인 정보가 올바르지 않습니다.' });
  }
  req.userId = userId;
  next();
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
    res.status(500).json({ success: false, message: 'DB 준비에 실패했습니다: ' + err.message });
  }
});

// ── Helpers ──────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_QTY = 20;
const FREE_SHIPPING_FROM = 50000;
const SHIPPING_FEE = 3000;

const fail = (res, status, message) => res.status(status).json({ success: false, message });

// NUMERIC/BIGINT 는 pg 가 문자열로 돌려주므로 숫자로 바꿔서 내보낸다
const toProduct = (r) => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  brand: r.brand,
  category: r.category,
  price: Number(r.price),
  listPrice: Number(r.list_price),
  image: r.image,
  description: r.description,
  badge: r.badge,
  rating: Number(r.rating),
  reviewCount: Number(r.review_count),
  stock: Number(r.stock),
});

// 1~MAX_QTY 범위의 정수로 맞춘다
function parseQty(raw, fallback) {
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(MAX_QTY, Math.max(1, n));
}

// 회원 장바구니든 비회원 장바구니든 합계는 여기 한 곳에서만 계산한다.
// entries: [{ cartItemId, product, qty }]
function summarizeCart(entries) {
  const items = entries.map(({ cartItemId, product, qty }) => ({
    cartItemId,
    qty,
    lineTotal: product.price * qty,
    lineListTotal: product.listPrice * qty,
    product,
  }));

  const subtotal = items.reduce((sum, it) => sum + it.lineTotal, 0);
  const listTotal = items.reduce((sum, it) => sum + it.lineListTotal, 0);
  // 5만원 이상이면 무료배송, 아니면 3,000원
  const shipping = items.length === 0 || subtotal >= FREE_SHIPPING_FROM ? 0 : SHIPPING_FEE;

  return {
    items,
    count: items.length,
    totalQty: items.reduce((sum, it) => sum + it.qty, 0),
    subtotal,
    discount: listTotal - subtotal,
    shipping,
    total: subtotal + shipping,
    freeShippingThreshold: FREE_SHIPPING_FROM,
  };
}

// 로그인한 사용자의 장바구니
async function readCart(userId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.qty, c.product_id, p.*
       FROM sh_cart_items c
       JOIN sh_products p ON p.id = c.product_id
      WHERE c.user_id = $1
      ORDER BY c.created_at DESC, c.id DESC`,
    [userId]
  );

  return summarizeCart(rows.map((r) => ({
    cartItemId: r.id,
    product: toProduct({ ...r, id: r.product_id }),
    qty: Number(r.qty),
  })));
}

// 비회원이 브라우저에 들고 있는 [{productId, qty}] 를 받아 서버 가격으로 다시 계산한다.
// 클라이언트가 보낸 가격은 절대 믿지 않는다.
async function quoteCart(rawItems) {
  const lines = [];
  const seen = new Set();

  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    const productId = Number(raw?.productId);
    if (!Number.isInteger(productId) || productId <= 0 || seen.has(productId)) continue;
    seen.add(productId);
    lines.push({ productId, qty: parseQty(raw?.qty, 1) });
  }
  if (lines.length === 0) return summarizeCart([]);

  const { rows } = await pool.query(
    'SELECT * FROM sh_products WHERE id = ANY($1::int[])',
    [lines.map((l) => l.productId)]
  );
  const byId = new Map(rows.map((r) => [r.id, toProduct(r)]));

  // 사라진 상품은 조용히 빼고 남은 것만 계산한다
  return summarizeCart(
    lines
      .filter((l) => byId.has(l.productId))
      .map((l) => ({ cartItemId: l.productId, product: byId.get(l.productId), qty: l.qty }))
  );
}

// ── API: 상품 (로그인 없이 누구나) ─────────────────────────────────

app.get('/api/products', async (req, res) => {
  const category = (req.query.category || '').trim();
  const q = (req.query.q || '').trim();
  const sort = (req.query.sort || 'recommend').trim();

  const where = [];
  const params = [];

  if (category && CATEGORIES.includes(category)) {
    params.push(category);
    where.push(`category = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(name ILIKE $${params.length} OR brand ILIKE $${params.length} OR description ILIKE $${params.length})`);
  }

  const orderBy = {
    recommend: 'review_count DESC, id ASC',
    new: 'id DESC',
    price_asc: 'price ASC, id ASC',
    price_desc: 'price DESC, id ASC',
    rating: 'rating DESC, review_count DESC',
    discount: '(list_price - price)::numeric / NULLIF(list_price, 0) DESC, id ASC',
  }[sort] || 'review_count DESC, id ASC';

  try {
    const { rows } = await pool.query(
      `SELECT * FROM sh_products
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY ${orderBy}`,
      params
    );
    res.json({ success: true, categories: CATEGORIES, products: rows.map(toProduct) });
  } catch (err) {
    console.error('[GET /api/products]', err.message);
    fail(res, 500, '상품을 불러오지 못했습니다.');
  }
});

app.get('/api/products/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, '상품 번호가 올바르지 않습니다.');

  try {
    const { rows } = await pool.query('SELECT * FROM sh_products WHERE id = $1', [id]);
    if (rows.length === 0) return fail(res, 404, '없는 상품입니다.');

    const product = toProduct(rows[0]);
    // 같은 카테고리에서 4개를 함께 보여준다
    const { rows: related } = await pool.query(
      'SELECT * FROM sh_products WHERE category = $1 AND id <> $2 ORDER BY review_count DESC LIMIT 4',
      [product.category, id]
    );
    res.json({ success: true, product, related: related.map(toProduct) });
  } catch (err) {
    console.error('[GET /api/products/:id]', err.message);
    fail(res, 500, '상품을 불러오지 못했습니다.');
  }
});

// ── API: 회원가입 / 로그인 ────────────────────────────────────────

app.post('/api/auth/signup', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const name = String(req.body?.name || '').trim();

  if (!EMAIL_RE.test(email)) return fail(res, 400, '이메일 형식을 확인해 주세요.');
  if (password.length < 8) return fail(res, 400, '비밀번호는 8자 이상으로 만들어 주세요.');
  if (name.length < 1 || name.length > 20) return fail(res, 400, '이름을 1~20자로 입력해 주세요.');

  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { rows } = await pool.query(
      'INSERT INTO sh_users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name',
      [email, passwordHash, name]
    );
    const user = rows[0];
    res.status(201).json({ success: true, token: signToken(user), user });
  } catch (err) {
    if (err.code === '23505') return fail(res, 409, '이미 가입된 이메일입니다. 로그인해 주세요.');
    if (err.status === 503) return fail(res, 503, err.message);
    console.error('[POST /api/auth/signup]', err.message);
    fail(res, 500, '가입을 마치지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return fail(res, 400, '이메일과 비밀번호를 입력해 주세요.');

  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, password_hash FROM sh_users WHERE email = $1',
      [email]
    );
    const row = rows[0];
    // 어느 쪽이 틀렸는지 알려 주지 않는다
    const ok = row ? await bcrypt.compare(password, row.password_hash) : false;
    if (!ok) return fail(res, 401, '이메일 또는 비밀번호가 맞지 않습니다.');

    const user = { id: row.id, email: row.email, name: row.name };
    res.json({ success: true, token: signToken(user), user });
  } catch (err) {
    if (err.status === 503) return fail(res, 503, err.message);
    console.error('[POST /api/auth/login]', err.message);
    fail(res, 500, '로그인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, email, name FROM sh_users WHERE id = $1', [req.userId]);
    if (rows.length === 0) return fail(res, 401, '로그인 정보가 올바르지 않습니다.');
    res.json({ success: true, user: rows[0] });
  } catch (err) {
    console.error('[GET /api/auth/me]', err.message);
    fail(res, 500, '사용자 정보를 불러오지 못했습니다.');
  }
});

// ── API: 장바구니 (로그인 필요) ───────────────────────────────────

// 비회원 장바구니는 브라우저가 들고 있고, 금액만 서버가 계산해 준다 (로그인 불필요)
app.post('/api/cart/quote', async (req, res) => {
  try {
    res.json({ success: true, cart: await quoteCart(req.body?.items) });
  } catch (err) {
    console.error('[POST /api/cart/quote]', err.message);
    fail(res, 500, '장바구니 금액을 계산하지 못했습니다.');
  }
});

// 비회원으로 담아 둔 상품을 로그인한 계정의 장바구니로 옮긴다
app.post('/api/cart/merge', requireAuth, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  try {
    for (const raw of items) {
      const productId = Number(raw?.productId);
      if (!Number.isInteger(productId) || productId <= 0) continue;
      const qty = parseQty(raw?.qty, 1);

      await pool.query(
        `INSERT INTO sh_cart_items (user_id, product_id, qty)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, product_id)
         DO UPDATE SET qty = LEAST($4::int, sh_cart_items.qty + EXCLUDED.qty), updated_at = now()`,
        [req.userId, productId, qty, MAX_QTY]
      );
    }
    res.json({ success: true, cart: await readCart(req.userId) });
  } catch (err) {
    console.error('[POST /api/cart/merge]', err.message);
    fail(res, 500, '담아 두신 상품을 옮기지 못했습니다.');
  }
});

app.get('/api/cart', requireAuth, async (req, res) => {
  try {
    res.json({ success: true, cart: await readCart(req.userId) });
  } catch (err) {
    console.error('[GET /api/cart]', err.message);
    fail(res, 500, '장바구니를 불러오지 못했습니다.');
  }
});

// 이미 담긴 상품이면 수량을 더한다
app.post('/api/cart', requireAuth, async (req, res) => {
  const productId = Number(req.body?.productId);
  const qty = parseQty(req.body?.qty, 1);
  if (!Number.isInteger(productId) || productId <= 0) return fail(res, 400, '상품 번호가 올바르지 않습니다.');

  try {
    const { rows } = await pool.query('SELECT id, stock FROM sh_products WHERE id = $1', [productId]);
    if (rows.length === 0) return fail(res, 404, '없는 상품입니다.');
    if (rows[0].stock <= 0) return fail(res, 409, '품절된 상품입니다.');

    await pool.query(
      `INSERT INTO sh_cart_items (user_id, product_id, qty)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, product_id)
       DO UPDATE SET qty = LEAST($4::int, sh_cart_items.qty + EXCLUDED.qty), updated_at = now()`,
      [req.userId, productId, qty, MAX_QTY]
    );
    res.status(201).json({ success: true, cart: await readCart(req.userId) });
  } catch (err) {
    console.error('[POST /api/cart]', err.message);
    fail(res, 500, '장바구니에 담지 못했습니다.');
  }
});

// 수량을 그 값으로 덮어쓴다(+/- 버튼이 보낸 값)
app.patch('/api/cart/:productId', requireAuth, async (req, res) => {
  const productId = Number(req.params.productId);
  if (!Number.isInteger(productId) || productId <= 0) return fail(res, 400, '상품 번호가 올바르지 않습니다.');

  const raw = Number(req.body?.qty);
  if (!Number.isInteger(raw)) return fail(res, 400, '수량이 올바르지 않습니다.');
  if (raw < 1) return fail(res, 400, '수량은 1개부터입니다. 빼려면 삭제해 주세요.');
  if (raw > MAX_QTY) return fail(res, 400, `한 상품은 ${MAX_QTY}개까지 담을 수 있습니다.`);

  try {
    const { rowCount } = await pool.query(
      'UPDATE sh_cart_items SET qty = $1, updated_at = now() WHERE user_id = $2 AND product_id = $3',
      [raw, req.userId, productId]
    );
    if (rowCount === 0) return fail(res, 404, '장바구니에 없는 상품입니다.');
    res.json({ success: true, cart: await readCart(req.userId) });
  } catch (err) {
    console.error('[PATCH /api/cart/:productId]', err.message);
    fail(res, 500, '수량을 바꾸지 못했습니다.');
  }
});

app.delete('/api/cart/:productId', requireAuth, async (req, res) => {
  const productId = Number(req.params.productId);
  if (!Number.isInteger(productId) || productId <= 0) return fail(res, 400, '상품 번호가 올바르지 않습니다.');

  try {
    const { rowCount } = await pool.query(
      'DELETE FROM sh_cart_items WHERE user_id = $1 AND product_id = $2',
      [req.userId, productId]
    );
    if (rowCount === 0) return fail(res, 404, '장바구니에 없는 상품입니다.');
    res.json({ success: true, cart: await readCart(req.userId) });
  } catch (err) {
    console.error('[DELETE /api/cart/:productId]', err.message);
    fail(res, 500, '상품을 빼지 못했습니다.');
  }
});

app.delete('/api/cart', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM sh_cart_items WHERE user_id = $1', [req.userId]);
    res.json({ success: true, cart: await readCart(req.userId) });
  } catch (err) {
    console.error('[DELETE /api/cart]', err.message);
    fail(res, 500, '장바구니를 비우지 못했습니다.');
  }
});

// ── API: 주문 ─────────────────────────────────────────────────────

// 주문서에 적힌 주문자 정보를 다듬는다. 비어 있으면 어디가 비었는지 알려 준다.
function readBuyer(body) {
  const buyer = {
    name: String(body?.buyer?.name || '').trim(),
    phone: String(body?.buyer?.phone || '').trim(),
    email: String(body?.buyer?.email || '').trim().toLowerCase(),
    address: String(body?.buyer?.address || '').trim(),
  };

  if (buyer.name.length < 1 || buyer.name.length > 20) return { error: '받는 분 이름을 1~20자로 입력해 주세요.' };
  if (!/^[\d-]{9,20}$/.test(buyer.phone)) return { error: '연락처를 숫자와 하이픈으로 입력해 주세요.' };
  if (!EMAIL_RE.test(buyer.email)) return { error: '이메일 형식을 확인해 주세요.' };
  if (buyer.address.length < 5) return { error: '배송 주소를 입력해 주세요.' };

  return { buyer };
}

const makeOrderNo = () =>
  new Date().toISOString().slice(0, 10).replace(/-/g, '') +
  '-' + crypto.randomBytes(3).toString('hex').toUpperCase();

// 주문 한 건과 품목을 한 트랜잭션으로 넣는다. 중간에 실패하면 전부 되돌린다.
// userId 가 null 이면 비회원 주문이고, 그 때는 장바구니를 비울 것이 없다.
async function createOrder({ userId, cart, buyer }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO sh_orders (user_id, order_no, total, buyer_name, buyer_phone, buyer_email, shipping_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, order_no, total, created_at`,
      [userId, makeOrderNo(), cart.total, buyer.name, buyer.phone, buyer.email, buyer.address]
    );
    const order = rows[0];

    for (const it of cart.items) {
      await client.query(
        `INSERT INTO sh_order_items (order_id, product_id, name, brand, image, price, qty)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [order.id, it.product.id, it.product.name, it.product.brand, it.product.image, it.product.price, it.qty]
      );
    }
    if (userId) await client.query('DELETE FROM sh_cart_items WHERE user_id = $1', [userId]);
    await client.query('COMMIT');

    return {
      id: order.id,
      orderNo: order.order_no,
      total: Number(order.total),
      createdAt: order.created_at,
      isGuest: !userId,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// 회원 주문 — 서버에 저장된 장바구니를 그대로 주문으로 옮기고 비운다
app.post('/api/orders', requireAuth, async (req, res) => {
  const { buyer, error } = readBuyer(req.body);
  if (error) return fail(res, 400, error);

  try {
    const cart = await readCart(req.userId);
    if (cart.items.length === 0) return fail(res, 400, '장바구니가 비어 있습니다.');

    const order = await createOrder({ userId: req.userId, cart, buyer });
    res.status(201).json({ success: true, order, cart: await readCart(req.userId) });
  } catch (err) {
    console.error('[POST /api/orders]', err.message);
    fail(res, 500, '주문을 마치지 못했습니다.');
  }
});

// 비회원 주문 — 브라우저가 들고 있던 장바구니를 받아 서버 가격으로 다시 계산해 주문한다
app.post('/api/orders/guest', async (req, res) => {
  const { buyer, error } = readBuyer(req.body);
  if (error) return fail(res, 400, error);

  try {
    const cart = await quoteCart(req.body?.items);
    if (cart.items.length === 0) return fail(res, 400, '주문할 상품이 없습니다.');

    const order = await createOrder({ userId: null, cart, buyer });
    res.status(201).json({ success: true, order });
  } catch (err) {
    console.error('[POST /api/orders/guest]', err.message);
    fail(res, 500, '주문을 마치지 못했습니다.');
  }
});

app.get('/api/orders', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.id, o.order_no, o.total, o.created_at,
              COALESCE(json_agg(json_build_object(
                'productId', i.product_id, 'name', i.name, 'brand', i.brand,
                'image', i.image, 'price', i.price, 'qty', i.qty
              ) ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
         FROM sh_orders o
         LEFT JOIN sh_order_items i ON i.order_id = o.id
        WHERE o.user_id = $1
        GROUP BY o.id
        ORDER BY o.created_at DESC, o.id DESC`,
      [req.userId]
    );
    res.json({
      success: true,
      orders: rows.map((r) => ({
        id: r.id,
        orderNo: r.order_no,
        total: Number(r.total),
        createdAt: r.created_at,
        items: r.items,
      })),
    });
  } catch (err) {
    console.error('[GET /api/orders]', err.message);
    fail(res, 500, '주문 내역을 불러오지 못했습니다.');
  }
});

// 없는 API 경로는 HTML 대신 JSON 으로 답한다
app.use('/api', (_req, res) => fail(res, 404, '없는 API 경로입니다.'));

// ── Start ────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`OFFDAY  →  http://localhost:${PORT}`);
    const problem = secretProblem();
    if (problem) console.warn('  ⚠ ' + problem);
    if (!process.env.DATABASE_URL) console.warn('  ⚠ DATABASE_URL 이 없습니다. .env 를 확인해 주세요.');
  });
}

module.exports = app;
