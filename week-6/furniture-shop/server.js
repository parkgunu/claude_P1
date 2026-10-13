// ── Module imports ───────────────────────────
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

// 로컬: .env 로드 (Vercel 에서는 대시보드 환경변수 사용)
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

// ── App init & config ────────────────────────
const app = express();
const PORT = process.env.PORT || 3015;
const JWT_SECRET = (process.env.JWT_SECRET || '').trim();
const JWT_EXPIRES_IN = '7d';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOSS_CLIENT_KEY = (process.env.TOSS_CLIENT_KEY || '').trim();
const TOSS_SECRET_KEY = (process.env.TOSS_SECRET_KEY || '').trim();
const FREE_SHIPPING = 500000;
const SHIPPING_FEE = 30000;

if (!JWT_SECRET) throw new Error('JWT_SECRET 환경변수가 없습니다');

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

// ── DB lazy init ─────────────────────────────
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gy_users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // gy_products 는 seed-products.js 로 채운다
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gy_orders (
      id          TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES gy_users(id) ON DELETE CASCADE,
      order_name  TEXT NOT NULL,
      items       JSONB NOT NULL,
      subtotal    INTEGER NOT NULL,
      shipping    INTEGER NOT NULL,
      amount      INTEGER NOT NULL,
      recipient   JSONB NOT NULL,
      status      TEXT NOT NULL DEFAULT 'READY',
      payment_key TEXT,
      method      TEXT,
      receipt_url TEXT,
      approved_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE gy_orders
      ADD COLUMN IF NOT EXISTS approve_no      TEXT,
      ADD COLUMN IF NOT EXISTS transaction_key TEXT,
      ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'PREPARING',
      ADD COLUMN IF NOT EXISTS delivered_at    TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS cancel_reason   TEXT,
      ADD COLUMN IF NOT EXISTS canceled_at     TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS refund_amount   INTEGER
  `);
  await pool.query("ALTER TABLE gy_products ADD COLUMN IF NOT EXISTS free_shipping BOOLEAN NOT NULL DEFAULT FALSE");
  dbInitialized = true;
}

// ── Middleware ───────────────────────────────
app.use(express.json());
// .env 등이 노출되지 않도록 폴더 전체가 아니라 images/ 만 정적 서빙
app.use('/images', express.static(path.join(__dirname, 'images')));

app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '데이터베이스 연결에 실패했습니다' });
  }
});

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

const publicUser = (u) => ({ id: u.id, email: u.email, createdAt: u.created_at });

// Authorization: Bearer <token> 검증
function requireAuth(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ success: false, message: '로그인이 필요합니다' });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ success: false, message: '인증이 만료되었거나 올바르지 않습니다' });
  }
}

function readCredentials(body) {
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  return { email, password };
}

// ── API routes: auth ─────────────────────────
app.get('/api/auth/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, email, created_at FROM gy_users WHERE id = $1', [req.user.sub]);
    if (!rows[0]) return res.status(404).json({ success: false, message: '사용자를 찾을 수 없습니다' });
    res.json({ success: true, data: publicUser(rows[0]) });
  } catch (err) { next(err); }
});

app.post('/api/auth/signup', async (req, res, next) => {
  try {
    const { email, password } = readCredentials(req.body);
    if (!EMAIL_RE.test(email)) return res.status(400).json({ success: false, message: '이메일 형식을 확인해 주세요' });
    if (password.length < 8) return res.status(400).json({ success: false, message: '비밀번호는 8자 이상이어야 합니다' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO gy_users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id, email, created_at',
      [email, hash],
    );
    if (!rows[0]) return res.status(409).json({ success: false, message: '이미 가입된 이메일입니다' });

    res.status(201).json({ success: true, data: { token: signToken(rows[0]), user: publicUser(rows[0]) } });
  } catch (err) { next(err); }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const { email, password } = readCredentials(req.body);
    if (!email || !password) return res.status(400).json({ success: false, message: '이메일과 비밀번호를 입력해 주세요' });

    const { rows } = await pool.query('SELECT * FROM gy_users WHERE email = $1', [email]);
    const user = rows[0];
    // 이메일 존재 여부를 드러내지 않도록 같은 메시지 사용
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ success: false, message: '이메일 또는 비밀번호가 올바르지 않습니다' });
    }
    res.json({ success: true, data: { token: signToken(user), user: publicUser(user) } });
  } catch (err) { next(err); }
});

// ── API routes: products ─────────────────────
const toProduct = (r) => ({
  id: r.id, name: r.name, en: r.en, category: r.category, price: r.price, badge: r.badge,
  material: r.material, size: r.size, colors: r.colors, desc: r.description, image: r.image,
  freeShipping: r.free_shipping,
});

app.get('/api/products', async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM gy_products ORDER BY sort_order, id');
    res.json({ success: true, data: rows.map(toProduct) });
  } catch (err) { next(err); }
});

app.get('/api/products/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM gy_products WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: '상품을 찾을 수 없습니다' });
    res.json({ success: true, data: toProduct(rows[0]) });
  } catch (err) { next(err); }
});

// ── API routes: payments config ──────────────
app.get('/api/config', (_req, res) => {
  res.json({ success: true, data: { tossClientKey: TOSS_CLIENT_KEY, cancelReasons: CANCEL_REASONS, returnReasons: RETURN_REASONS, returnDays: RETURN_DAYS } });
});

// ── API routes: orders ───────────────────────
const toOrder = (r) => ({
  id: r.id, orderName: r.order_name, items: r.items, subtotal: r.subtotal, shipping: r.shipping,
  amount: r.amount, recipient: r.recipient, status: r.status, method: r.method,
  receiptUrl: r.receipt_url, approvedAt: r.approved_at, createdAt: r.created_at,
  approveNo: r.approve_no, transactionKey: r.transaction_key,
  deliveryStatus: r.delivery_status, deliveredAt: r.delivered_at,
  cancelReason: r.cancel_reason, canceledAt: r.canceled_at, refundAmount: r.refund_amount,
  ...orderActions(r),
});

const RETURN_DAYS = 30;
const CANCEL_REASONS = ['단순 변심', '다른 상품으로 다시 주문', '배송 지연', '기타'];
const RETURN_REASONS = ['단순 변심', '상품 불량·파손', '상품이 설명과 다름', '오배송', '기타'];

// 지금 이 주문에 허용되는 동작 — 화면 버튼과 서버 검증이 같은 규칙을 쓴다
function orderActions(r) {
  const returnDeadline = r.delivered_at ? new Date(new Date(r.delivered_at).getTime() + RETURN_DAYS * 86400000) : null;
  return {
    canCancel: r.status === 'READY' || (r.status === 'DONE' && r.delivery_status === 'PREPARING'),
    canReturn: r.status === 'DONE' && r.delivery_status === 'DELIVERED' && returnDeadline > new Date(),
    returnDeadline,
  };
}

async function findMyOrder(orderId, userId) {
  const { rows } = await pool.query('SELECT * FROM gy_orders WHERE id = $1 AND user_id = $2', [orderId, userId]);
  return rows[0];
}

// 토스 전액 취소 + 응답 대조. 실패하면 Error 를 던진다
async function refundPayment(order, reason) {
  const { ok, data } = await toss(`/payments/${encodeURIComponent(order.payment_key)}/cancel`, { cancelReason: reason });
  if (!ok) throw Object.assign(new Error(data.message || '결제 취소에 실패했습니다'), { status: 400, code: data.code });
  const refunded = (data.cancels || []).reduce((s, c) => s + (c.cancelAmount || 0), 0);
  if (data.status !== 'CANCELED' || refunded !== order.amount) {
    console.warn('[refund] 환불 금액 불일치', { orderId: order.id, amount: order.amount, refunded, status: data.status });
    throw Object.assign(new Error('환불 금액 확인에 실패했습니다. 고객센터로 문의해 주세요'), { status: 502 });
  }
  return refunded;
}

// 내 주문 목록 — 사용자 ID 는 요청 값이 아니라 검증된 JWT(req.user.sub)에서만 가져온다
app.get('/api/orders', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM gy_orders WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.sub],
    );
    res.json({ success: true, data: rows.map(toOrder) });
  } catch (err) { next(err); }
});

// 주문 상세 — 본인 주문만
app.get('/api/orders/:id', requireAuth, async (req, res, next) => {
  try {
    const order = await findMyOrder(req.params.id, req.user.sub);
    if (!order) return res.status(404).json({ success: false, message: '주문을 찾을 수 없습니다' });
    res.json({ success: true, data: toOrder(order) });
  } catch (err) { next(err); }
});

// 주문 생성 — 금액은 클라이언트 값이 아니라 DB 가격으로 서버가 계산한다
app.post('/api/orders', requireAuth, async (req, res, next) => {
  try {
    const { items, recipient } = req.body || {};
    if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
      return res.status(400).json({ success: false, message: '주문할 상품이 없습니다' });
    }
    const name = String(recipient?.name || '').trim();
    const phone = String(recipient?.phone || '').trim();
    const address = String(recipient?.address || '').trim();
    if (!name || !/^01\d-?\d{3,4}-?\d{4}$/.test(phone) || address.length < 5) {
      return res.status(400).json({ success: false, message: '배송 정보를 확인해 주세요' });
    }

    const ids = [...new Set(items.map((i) => String(i.id)))];
    const { rows } = await pool.query('SELECT * FROM gy_products WHERE id = ANY($1)', [ids]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    const lines = [];
    for (const i of items) {
      const p = byId[i.id];
      const qty = Number(i.qty);
      if (!p || !Number.isInteger(qty) || qty < 1 || qty > 9) {
        return res.status(400).json({ success: false, message: '주문 상품 정보가 올바르지 않습니다' });
      }
      lines.push({ id: p.id, name: p.name, image: p.image, color: String(i.color || ''), qty, price: p.price, freeShipping: p.free_shipping });
    }
    const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
    // 50만원 이상이거나, 담긴 상품이 전부 배송비 무료 상품(결제 테스트용 등)이면 배송비 0원
    const shipping = subtotal >= FREE_SHIPPING || lines.every((l) => l.freeShipping) ? 0 : SHIPPING_FEE;
    const amount = subtotal + shipping;
    const orderName = lines.length > 1 ? `${lines[0].name} 외 ${lines.length - 1}건` : lines[0].name;
    const orderId = `GY${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

    await pool.query(
      `INSERT INTO gy_orders (id, user_id, order_name, items, subtotal, shipping, amount, recipient)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [orderId, req.user.sub, orderName, JSON.stringify(lines), subtotal, shipping, amount, JSON.stringify({ name, phone, address })],
    );
    res.status(201).json({ success: true, data: { orderId, orderName, amount } });
  } catch (err) { next(err); }
});

// 토스 API 호출 (시크릿 키 Basic 인증)
async function toss(pathname, body) {
  const r = await fetch(`https://api.tosspayments.com/v1${pathname}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Basic ${Buffer.from(`${TOSS_SECRET_KEY}:`).toString('base64')}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: r.ok, data: await r.json() };
}

// 결제 승인 — 토스 successUrl 로 돌아온 뒤 호출.
// ① 쿼리스트링 금액 ↔ DB 주문 금액 ② 토스에 결제를 다시 조회해 금액·주문번호 대조
// ③ 승인 후 응답도 한 번 더 대조(어긋나면 즉시 취소) ④ 승인번호 저장
app.post('/api/payments/confirm', requireAuth, async (req, res, next) => {
  const fail = async (orderId, status, message, extra = {}) => {
    await pool.query("UPDATE gy_orders SET status = 'FAILED' WHERE id = $1 AND status = 'CONFIRMING'", [orderId]);
    return res.status(status).json({ success: false, message, ...extra });
  };
  try {
    const { paymentKey, orderId } = req.body || {};
    const amount = Number(req.body?.amount);
    if (!paymentKey || !orderId || !Number.isInteger(amount)) {
      return res.status(400).json({ success: false, message: '결제 정보가 올바르지 않습니다' });
    }
    const { rows } = await pool.query('SELECT * FROM gy_orders WHERE id = $1 AND user_id = $2', [orderId, req.user.sub]);
    const order = rows[0];
    if (!order) return res.status(404).json({ success: false, message: '주문을 찾을 수 없습니다' });
    if (order.status === 'DONE') return res.json({ success: true, data: toOrder(order) }); // 새로고침 등 중복 호출
    if (order.amount !== amount) return res.status(400).json({ success: false, message: '결제 금액이 주문 금액과 다릅니다' });

    // 동시에 두 번 승인 요청이 와도 한 번만 진행되도록 READY → CONFIRMING 으로 선점
    const lock = await pool.query("UPDATE gy_orders SET status = 'CONFIRMING' WHERE id = $1 AND status = 'READY' RETURNING id", [orderId]);
    if (!lock.rowCount) return res.status(409).json({ success: false, message: '이미 처리 중이거나 종료된 주문입니다' });

    // ② 승인 전: 토스에 결제를 다시 조회해 금액·주문번호 대조
    const before = await toss(`/payments/${encodeURIComponent(paymentKey)}`);
    if (!before.ok) return fail(orderId, 400, before.data.message || '결제 정보를 조회하지 못했습니다', { code: before.data.code });
    if (before.data.orderId !== order.id || before.data.totalAmount !== order.amount) {
      console.warn('[confirm] 사전 대조 불일치', { orderId, db: order.amount, toss: before.data.totalAmount, tossOrderId: before.data.orderId });
      return fail(orderId, 400, '결제 금액이 주문 금액과 다릅니다');
    }

    // 승인 요청 — 금액은 클라이언트 값이 아니라 DB 금액을 보낸다
    const confirmed = await toss('/payments/confirm', { paymentKey, orderId, amount: order.amount });
    if (!confirmed.ok) return fail(orderId, 400, confirmed.data.message || '결제 승인에 실패했습니다', { code: confirmed.data.code });
    const payment = confirmed.data;

    // ③ 승인 후: 응답을 다시 대조. 어긋나면 결제를 취소한다
    if (payment.status !== 'DONE' || payment.orderId !== order.id || payment.totalAmount !== order.amount) {
      console.warn('[confirm] 사후 대조 불일치 — 결제 취소', { orderId, status: payment.status, toss: payment.totalAmount });
      await toss(`/payments/${encodeURIComponent(paymentKey)}/cancel`, { cancelReason: '결제 금액 불일치' });
      return fail(orderId, 400, '결제 금액 검증에 실패해 결제를 취소했습니다');
    }

    // ④ 승인번호: 카드 결제는 카드사 승인번호(card.approveNo).
    //    계좌이체·간편결제는 토스가 승인번호를 주지 않으므로 거래 키(lastTransactionKey)를 함께 저장한다
    const { rows: updated } = await pool.query(
      `UPDATE gy_orders SET status = 'DONE', payment_key = $2, method = $3, receipt_url = $4, approved_at = $5,
         approve_no = $6, transaction_key = $7
       WHERE id = $1 RETURNING *`,
      [orderId, payment.paymentKey, payment.method, payment.receipt?.url || null, payment.approvedAt || new Date(),
        payment.card?.approveNo || null, payment.lastTransactionKey || null],
    );
    res.json({ success: true, data: toOrder(updated[0]) });
  } catch (err) {
    await pool.query("UPDATE gy_orders SET status = 'FAILED' WHERE id = $1 AND status = 'CONFIRMING'", [req.body?.orderId]).catch(() => {});
    next(err);
  }
});

// ── API routes: 취소 · 반품 ──────────────────
// 상태 전이는 "조건부 UPDATE ... RETURNING" 으로 선점해 중복 요청·경쟁 상태를 막는다.
// 토스 환불이 실패하면 원래 상태로 되돌린다.

// 주문 취소 — 결제 대기 주문, 또는 결제 완료 + 배송 준비중
app.post('/api/orders/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '');
    if (!CANCEL_REASONS.includes(reason)) return res.status(400).json({ success: false, message: '취소 사유를 선택해 주세요' });
    const order = await findMyOrder(req.params.id, req.user.sub);
    if (!order) return res.status(404).json({ success: false, message: '주문을 찾을 수 없습니다' });
    if (!orderActions(order).canCancel) {
      const message = order.delivery_status !== 'PREPARING' && order.status === 'DONE'
        ? '이미 출고된 주문은 취소할 수 없어요. 받으신 뒤 반품을 신청해 주세요'
        : '취소할 수 없는 주문입니다';
      return res.status(409).json({ success: false, message });
    }

    // 미결제 주문은 토스 호출 없이 취소
    if (order.status === 'READY') {
      const { rows } = await pool.query(
        `UPDATE gy_orders SET status = 'CANCELED', cancel_reason = $2, canceled_at = NOW(), refund_amount = 0
         WHERE id = $1 AND status = 'READY' RETURNING *`, [order.id, reason]);
      if (!rows[0]) return res.status(409).json({ success: false, message: '주문 상태가 바뀌었어요. 새로고침해 주세요' });
      return res.json({ success: true, data: toOrder(rows[0]) });
    }

    const lock = await pool.query(
      "UPDATE gy_orders SET status = 'CANCELING' WHERE id = $1 AND status = 'DONE' AND delivery_status = 'PREPARING' RETURNING id", [order.id]);
    if (!lock.rowCount) return res.status(409).json({ success: false, message: '주문 상태가 바뀌었어요. 새로고침해 주세요' });
    try {
      const refunded = await refundPayment(order, `고객 주문 취소: ${reason}`);
      const { rows } = await pool.query(
        `UPDATE gy_orders SET status = 'CANCELED', cancel_reason = $2, canceled_at = NOW(), refund_amount = $3
         WHERE id = $1 RETURNING *`, [order.id, reason, refunded]);
      res.json({ success: true, data: toOrder(rows[0]) });
    } catch (e) {
      await pool.query("UPDATE gy_orders SET status = 'DONE' WHERE id = $1 AND status = 'CANCELING'", [order.id]);
      res.status(e.status || 500).json({ success: false, message: e.message, code: e.code });
    }
  } catch (err) { next(err); }
});

// 반품 신청 — 배송 완료 후 30일 이내. 데모에서는 신청 즉시 회수·검수 완료로 보고 전액 환불한다
app.post('/api/orders/:id/return', requireAuth, async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '');
    if (!RETURN_REASONS.includes(reason)) return res.status(400).json({ success: false, message: '반품 사유를 선택해 주세요' });
    const order = await findMyOrder(req.params.id, req.user.sub);
    if (!order) return res.status(404).json({ success: false, message: '주문을 찾을 수 없습니다' });
    if (!orderActions(order).canReturn) {
      const message = order.status === 'DONE' && order.delivery_status === 'DELIVERED'
        ? `반품 신청 기간(배송 완료 후 ${RETURN_DAYS}일)이 지났어요`
        : '배송 완료된 주문만 반품할 수 있어요';
      return res.status(409).json({ success: false, message });
    }

    const lock = await pool.query(
      "UPDATE gy_orders SET status = 'RETURNING' WHERE id = $1 AND status = 'DONE' AND delivery_status = 'DELIVERED' RETURNING id", [order.id]);
    if (!lock.rowCount) return res.status(409).json({ success: false, message: '주문 상태가 바뀌었어요. 새로고침해 주세요' });
    try {
      const refunded = await refundPayment(order, `고객 반품: ${reason}`);
      const { rows } = await pool.query(
        `UPDATE gy_orders SET status = 'RETURNED', cancel_reason = $2, canceled_at = NOW(), refund_amount = $3
         WHERE id = $1 RETURNING *`, [order.id, reason, refunded]);
      res.json({ success: true, data: toOrder(rows[0]) });
    } catch (e) {
      await pool.query("UPDATE gy_orders SET status = 'DONE' WHERE id = $1 AND status = 'RETURNING'", [order.id]);
      res.status(e.status || 500).json({ success: false, message: e.message, code: e.code });
    }
  } catch (err) { next(err); }
});

// [데모 전용] 배송 단계 진행 — 관리자·택배사 연동이 없어서 테스트용으로 둔다.
// 실제 서비스에서는 이 엔드포인트를 지우고 관리자 화면이나 택배사 웹훅으로 바꿔야 한다.
const DELIVERY_NEXT = { PREPARING: 'SHIPPED', SHIPPED: 'DELIVERED' };
app.post('/api/orders/:id/demo-advance-delivery', requireAuth, async (req, res, next) => {
  try {
    const order = await findMyOrder(req.params.id, req.user.sub);
    if (!order || order.status !== 'DONE' || !DELIVERY_NEXT[order.delivery_status]) {
      return res.status(409).json({ success: false, message: '배송 단계를 진행할 수 없는 주문입니다' });
    }
    const nextStage = DELIVERY_NEXT[order.delivery_status];
    const { rows } = await pool.query(
      `UPDATE gy_orders SET delivery_status = $2, delivered_at = CASE WHEN $2 = 'DELIVERED' THEN NOW() ELSE delivered_at END
       WHERE id = $1 AND delivery_status = $3 RETURNING *`, [order.id, nextStage, order.delivery_status]);
    if (!rows[0]) return res.status(409).json({ success: false, message: '주문 상태가 바뀌었어요. 새로고침해 주세요' });
    res.json({ success: true, data: toOrder(rows[0]) });
  } catch (err) { next(err); }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: 'API를 찾을 수 없습니다' });
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: '요청 형식이 올바르지 않습니다' });
  }
  res.status(500).json({ success: false, message: '서버 오류가 발생했습니다' });
});

// ── Startup & export ─────────────────────────
if (require.main === module) {
  app.listen(PORT, () => console.log(`GYEOL server running on http://localhost:${PORT}`));
}
module.exports = app;
