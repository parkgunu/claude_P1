/**
 * 냉장고 파먹기 — 재료 & 레시피 관리 API 서버
 *
 * 로컬:    node server.js          (http://localhost:3010)
 * 시드:    node server.js --seed   (스키마 생성 + 초기 데이터 적재)
 * Vercel:  module.exports = app 로 서버리스 함수로 동작
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const { Pool } = require('pg');

// ── App init & config ────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3010;

/**
 * Supabase 연결 주의:
 * db.<ref>.supabase.co 직접 호스트는 AAAA(IPv6) 레코드만 있어 IPv4 환경에서 ENOTFOUND 가 난다.
 * 반드시 IPv4 Session pooler(aws-0-<region>.pooler.supabase.com, user=postgres.<ref>)를 쓴다.
 * 환경변수에 trailing newline 이 붙는 경우가 있어 .trim() 은 필수.
 */
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => console.error('[pool] idle client error:', err.message));

// ── 초기 시드 데이터 (최초 1회만 DB 로 적재된다) ──────────────────
const SEED_INGREDIENTS = [
  { id: 'pork-belly', name: '돼지고기 앞다리살', category: '단백질', quantity: 400, unit: 'g', storage: '냉장', purchasedOn: '2026-09-14', expiresOn: '2026-09-18', tags: ['주재료', '급함'], note: '찌개용 깍둑썰기 상태' },
  { id: 'milk', name: '우유', category: '유제품', quantity: 900, unit: 'ml', storage: '냉장', purchasedOn: '2026-09-09', expiresOn: '2026-09-19', tags: ['급함'], note: '개봉함. 빨리 써야 함' },
  { id: 'tofu', name: '두부', category: '단백질', quantity: 1, unit: '모', storage: '냉장', purchasedOn: '2026-09-12', expiresOn: '2026-09-19', tags: ['주재료'], note: '찌개용 부침두부' },
  { id: 'zucchini', name: '애호박', category: '채소', quantity: 1, unit: '개', storage: '냉장', purchasedOn: '2026-09-13', expiresOn: '2026-09-20', tags: ['주재료'], note: '' },
  { id: 'king-oyster-mushroom', name: '새송이버섯', category: '채소', quantity: 3, unit: '개', storage: '냉장', purchasedOn: '2026-09-10', expiresOn: '2026-09-22', tags: ['부재료'], note: '' },
  { id: 'cheongyang-chili', name: '청양고추', category: '채소', quantity: 5, unit: '개', storage: '냉장', purchasedOn: '2026-09-11', expiresOn: '2026-09-23', tags: ['부재료'], note: '매운맛 조절용' },
  { id: 'green-onion', name: '대파', category: '채소', quantity: 2, unit: '대', storage: '냉장', purchasedOn: '2026-09-11', expiresOn: '2026-09-24', tags: ['부재료', '만능'], note: '흰 부분 많음' },
  { id: 'carrot', name: '당근', category: '채소', quantity: 1, unit: '개', storage: '냉장', purchasedOn: '2026-09-02', expiresOn: '2026-09-26', tags: ['부재료'], note: '반 개는 잘라둔 상태' },
  { id: 'egg', name: '달걀', category: '단백질', quantity: 8, unit: '개', storage: '냉장', purchasedOn: '2026-09-08', expiresOn: '2026-10-02', tags: ['주재료', '만능'], note: '특란. 프라이·찜·부침 다 가능' },
  { id: 'minced-garlic', name: '다진마늘', category: '양념', quantity: 120, unit: 'g', storage: '냉장', purchasedOn: '2026-09-01', expiresOn: '2026-10-05', tags: ['양념', '만능'], note: '냉장 보관 중' },
  { id: 'onion', name: '양파', category: '채소', quantity: 3, unit: '개', storage: '실온', purchasedOn: '2026-09-05', expiresOn: '2026-10-20', tags: ['부재료', '만능'], note: '' },
  { id: 'potato', name: '감자', category: '채소', quantity: 4, unit: '개', storage: '실온', purchasedOn: '2026-09-05', expiresOn: '2026-10-25', tags: ['주재료'], note: '싹 없음' },
  { id: 'cheddar-slice', name: '체다 슬라이스 치즈', category: '유제품', quantity: 6, unit: '장', storage: '냉장', purchasedOn: '2026-08-30', expiresOn: '2026-11-15', tags: ['부재료'], note: '' },
  { id: 'kimchi', name: '배추김치', category: '채소/절임', quantity: 600, unit: 'g', storage: '냉장', purchasedOn: '2026-08-20', expiresOn: '2026-11-30', tags: ['주재료', '신김치'], note: '3주 넘어 시어짐. 볶음·찌개용으로 좋음' },
  { id: 'butter', name: '가염버터', category: '유제품', quantity: 200, unit: 'g', storage: '냉장', purchasedOn: '2026-08-25', expiresOn: '2026-12-10', tags: ['부재료'], note: '' },
  { id: 'instant-rice', name: '즉석밥', category: '곡물', quantity: 3, unit: '개', storage: '실온', purchasedOn: '2026-07-15', expiresOn: '2027-01-20', tags: ['주식'], note: '' },
  { id: 'mayonnaise', name: '마요네즈', category: '양념', quantity: 300, unit: 'g', storage: '냉장', purchasedOn: '2026-06-18', expiresOn: '2027-02-18', tags: ['양념'], note: '' },
  { id: 'gim', name: '구운 김', category: '건어물', quantity: 10, unit: '장', storage: '실온', purchasedOn: '2026-08-02', expiresOn: '2027-03-01', tags: ['부재료'], note: '' },
  { id: 'gochujang', name: '고추장', category: '양념', quantity: 500, unit: 'g', storage: '냉장', purchasedOn: '2026-04-02', expiresOn: '2027-04-02', tags: ['양념'], note: '' },
  { id: 'spam', name: '스팸', category: '가공육', quantity: 200, unit: 'g', storage: '실온', purchasedOn: '2026-06-01', expiresOn: '2027-05-01', tags: ['주재료', '비상용'], note: '미개봉 캔' },
  { id: 'sesame-oil', name: '참기름', category: '양념', quantity: 320, unit: 'ml', storage: '실온', purchasedOn: '2026-02-11', expiresOn: '2027-08-11', tags: ['양념'], note: '' },
  { id: 'soy-sauce', name: '진간장', category: '양념', quantity: 900, unit: 'ml', storage: '실온', purchasedOn: '2026-03-10', expiresOn: '2028-03-10', tags: ['양념'], note: '' },
  { id: 'tuna-can', name: '참치캔', category: '가공육', quantity: 150, unit: 'g', storage: '실온', purchasedOn: '2026-05-20', expiresOn: '2028-04-10', tags: ['주재료', '비상용'], note: '기름 담금' },
];

/** 레시피가 참조하지만 냉장고에 없는 재료의 표시 이름 */
const PANTRY_NAMES = {
  'flour': '밀가루', 'frying-mix': '부침가루', 'saeujeot': '새우젓',
  'ramen-noodle': '라면사리', 'baked-beans': '베이크드빈', 'red-pepper-powder': '고춧가루',
};

const SEED_RECIPES = [
  {
    id: 'kimchi-jjigae', name: '돼지고기 김치찌개', emoji: '🍲', minutes: 25, difficulty: '쉬움', servings: 2,
    tags: ['한식', '찌개', '매콤'],
    summary: '신김치와 앞다리살로 끓이는 기본 김치찌개. 김치를 먼저 볶아야 깊은 맛이 난다.',
    ingredients: [
      { id: 'kimchi', amount: '300g' }, { id: 'pork-belly', amount: '200g' },
      { id: 'tofu', amount: '1/2모' }, { id: 'onion', amount: '1/2개' },
      { id: 'green-onion', amount: '1대' }, { id: 'minced-garlic', amount: '1큰술' },
      { id: 'gochujang', amount: '1큰술' }, { id: 'cheongyang-chili', amount: '1개', optional: true },
    ],
    steps: [
      '김치를 한입 크기로 썰고, 앞다리살은 깍둑 썬다.',
      '냄비에 기름을 두르고 고기를 겉면만 익힌 뒤 김치를 넣어 5분간 볶는다.',
      '물 500ml를 붓고 다진마늘과 고추장을 풀어 15분간 끓인다.',
      '양파와 두부를 넣고 5분 더 끓인다.',
      '대파와 청양고추를 올리고 불을 끈다.',
    ],
  },
  {
    id: 'dubu-kimchi', name: '두부김치', emoji: '🥢', minutes: 20, difficulty: '쉬움', servings: 2,
    tags: ['한식', '안주'],
    summary: '데친 두부에 볶은 김치를 곁들이는 술안주. 두부는 끓는 물에 데쳐야 부드럽다.',
    ingredients: [
      { id: 'tofu', amount: '1모' }, { id: 'kimchi', amount: '200g' },
      { id: 'pork-belly', amount: '150g' }, { id: 'green-onion', amount: '1대' },
      { id: 'minced-garlic', amount: '1/2큰술' }, { id: 'sesame-oil', amount: '1큰술' },
    ],
    steps: [
      '두부는 1cm 두께로 썰어 끓는 소금물에 3분간 데친다.',
      '팬에 고기를 볶다가 김치와 다진마늘을 넣고 강불에서 볶는다.',
      '김치가 투명해지면 참기름을 두르고 불을 끈다.',
      '접시 가장자리에 두부를 두르고 가운데 김치볶음을 담는다.',
      '대파를 송송 썰어 올린다.',
    ],
  },
  {
    id: 'tuna-mayo-bowl', name: '참치마요 덮밥', emoji: '🍚', minutes: 10, difficulty: '아주 쉬움', servings: 1,
    tags: ['한그릇', '초간단'],
    summary: '즉석밥과 참치캔만 있으면 10분. 야식이나 혼밥용으로 가장 빠른 선택.',
    ingredients: [
      { id: 'instant-rice', amount: '1개' }, { id: 'tuna-can', amount: '1캔' },
      { id: 'mayonnaise', amount: '2큰술' }, { id: 'egg', amount: '1개' },
      { id: 'soy-sauce', amount: '1작은술' }, { id: 'green-onion', amount: '약간' },
      { id: 'gim', amount: '2장', optional: true },
    ],
    steps: [
      '즉석밥을 데운다.',
      '참치는 기름을 따라내고 마요네즈, 간장과 섞는다.',
      '팬에 반숙 프라이를 하나 부친다.',
      '밥 위에 참치마요를 올리고 계란을 얹는다.',
      '대파와 잘게 부순 김을 뿌린다.',
    ],
  },
  {
    id: 'spam-kimchi-fried-rice', name: '스팸 김치볶음밥', emoji: '🍳', minutes: 15, difficulty: '쉬움', servings: 1,
    tags: ['한그릇', '든든'],
    summary: '신김치일수록 맛있다. 밥을 넣기 전에 김치를 충분히 볶는 게 핵심.',
    ingredients: [
      { id: 'spam', amount: '1/2캔' }, { id: 'kimchi', amount: '150g' },
      { id: 'instant-rice', amount: '1개' }, { id: 'egg', amount: '1개' },
      { id: 'green-onion', amount: '1대' }, { id: 'sesame-oil', amount: '1작은술' },
      { id: 'soy-sauce', amount: '1작은술' },
    ],
    steps: [
      '스팸과 김치를 잘게 깍둑 썬다.',
      '팬에 스팸을 먼저 볶아 기름을 낸다.',
      '김치를 넣고 5분간 볶다가 간장을 두른다.',
      '즉석밥을 넣고 덩어리를 풀어가며 볶는다.',
      '참기름과 대파를 넣고, 프라이를 얹어 낸다.',
    ],
  },
  {
    id: 'gamja-bokkeum', name: '감자채볶음', emoji: '🥔', minutes: 15, difficulty: '쉬움', servings: 2,
    tags: ['밑반찬', '순한맛'],
    summary: '채 썬 감자를 물에 헹궈 전분을 빼야 눅눅해지지 않는다.',
    ingredients: [
      { id: 'potato', amount: '2개' }, { id: 'onion', amount: '1/2개' },
      { id: 'minced-garlic', amount: '1/2큰술' }, { id: 'sesame-oil', amount: '1큰술' },
      { id: 'green-onion', amount: '약간', optional: true },
    ],
    steps: [
      '감자는 채 썰어 찬물에 5분 담갔다가 물기를 뺀다.',
      '팬에 기름을 두르고 양파와 다진마늘을 볶는다.',
      '감자채를 넣고 소금 간을 하며 중불에서 볶는다.',
      '감자가 투명해지면 참기름을 두르고 불을 끈다.',
    ],
  },
  {
    id: 'mushroom-butter', name: '새송이 버터구이', emoji: '🍄', minutes: 10, difficulty: '아주 쉬움', servings: 1,
    tags: ['안주', '초간단'],
    summary: '버섯을 두껍게 썰어 노릇하게 굽는 게 전부. 임박한 버섯 처리에 좋다.',
    ingredients: [
      { id: 'king-oyster-mushroom', amount: '2개' }, { id: 'butter', amount: '20g' },
      { id: 'soy-sauce', amount: '1작은술' }, { id: 'minced-garlic', amount: '1/2큰술' },
    ],
    steps: [
      '새송이는 1cm 두께로 도톰하게 썬다.',
      '팬에 버터를 녹이고 다진마늘을 볶아 향을 낸다.',
      '버섯을 올려 양면을 노릇하게 굽는다.',
      '간장을 팬 가장자리에 둘러 향을 입힌다.',
    ],
  },
  {
    id: 'carrot-egg-roll', name: '당근 계란말이', emoji: '🥕', minutes: 15, difficulty: '보통', servings: 2,
    tags: ['밑반찬', '도시락'],
    summary: '약불에서 천천히 말아야 터지지 않는다. 자투리 당근 처리용.',
    ingredients: [
      { id: 'egg', amount: '3개' }, { id: 'carrot', amount: '1/2개' },
      { id: 'green-onion', amount: '1대' }, { id: 'sesame-oil', amount: '1작은술' },
      { id: 'soy-sauce', amount: '1작은술', optional: true },
    ],
    steps: [
      '당근과 대파를 아주 잘게 다진다.',
      '계란을 풀어 다진 채소와 소금을 섞고 체에 한 번 거른다.',
      '약불로 달군 팬에 기름을 얇게 두르고 계란물을 3번에 나눠 부으며 만다.',
      '한 김 식힌 뒤 썰어 담고 참기름을 살짝 바른다.',
    ],
  },
  {
    id: 'zucchini-jeon', name: '애호박전', emoji: '🥒', minutes: 15, difficulty: '쉬움', servings: 2,
    tags: ['한식', '부침'],
    summary: '애호박을 얇게 썰어 계란옷을 입혀 부친다. 밀가루가 있어야 옷이 붙는다.',
    ingredients: [
      { id: 'zucchini', amount: '1개' }, { id: 'egg', amount: '2개' },
      { id: 'flour', amount: '3큰술' }, { id: 'soy-sauce', amount: '곁들임', optional: true },
    ],
    steps: [
      '애호박을 0.5cm 두께로 썰어 소금을 살짝 뿌려둔다.',
      '물기를 닦고 밀가루를 얇게 묻힌다.',
      '풀어둔 계란물에 담갔다가 중약불 팬에 올린다.',
      '양면을 노릇하게 부쳐 간장을 곁들인다.',
    ],
  },
  {
    id: 'gyeran-jjim', name: '뚝배기 계란찜', emoji: '🥚', minutes: 15, difficulty: '보통', servings: 2,
    tags: ['한식', '반찬'],
    summary: '우유를 조금 넣으면 훨씬 부드럽다. 새우젓으로 간을 맞추는 게 정석.',
    ingredients: [
      { id: 'egg', amount: '3개' }, { id: 'milk', amount: '100ml' },
      { id: 'saeujeot', amount: '1/2작은술' }, { id: 'green-onion', amount: '약간' },
    ],
    steps: [
      '계란을 풀고 우유와 물 100ml를 섞는다.',
      '새우젓으로 간을 맞추고 체에 거른다.',
      '뚝배기에 붓고 약불에서 저어가며 7분간 익힌다.',
      '뚜껑을 덮고 3분 뜸 들인 뒤 대파를 올린다.',
    ],
  },
  {
    id: 'budae-jjigae', name: '부대찌개', emoji: '🍜', minutes: 30, difficulty: '보통', servings: 3,
    tags: ['한식', '찌개', '매콤'],
    summary: '스팸과 김치가 베이스. 라면사리와 고춧가루가 있어야 제맛이 난다.',
    ingredients: [
      { id: 'spam', amount: '1/2캔' }, { id: 'kimchi', amount: '150g' },
      { id: 'tofu', amount: '1/2모' }, { id: 'onion', amount: '1/2개' },
      { id: 'green-onion', amount: '1대' }, { id: 'gochujang', amount: '1큰술' },
      { id: 'red-pepper-powder', amount: '1큰술' }, { id: 'ramen-noodle', amount: '1개' },
      { id: 'baked-beans', amount: '2큰술', optional: true },
    ],
    steps: [
      '스팸, 김치, 두부, 양파를 먹기 좋게 썬다.',
      '냄비에 재료를 돌려 담고 고추장과 고춧가루를 가운데 올린다.',
      '육수 700ml를 붓고 센불에서 끓인다.',
      '끓어오르면 라면사리를 넣고 3분간 더 끓인다.',
      '대파를 올려 마무리한다.',
    ],
  },
];

// ── 스키마 & 시드 ────────────────────────────────────────────────

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS ingredients (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    category      TEXT NOT NULL,
    quantity      NUMERIC NOT NULL CHECK (quantity > 0),
    unit          TEXT NOT NULL,
    storage       TEXT NOT NULL,
    purchased_on  DATE NOT NULL,
    expires_on    DATE NOT NULL,
    tags          TEXT[] NOT NULL DEFAULT '{}',
    note          TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS ingredients_expires_on_idx ON ingredients (expires_on);

  CREATE TABLE IF NOT EXISTS recipes (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    emoji       TEXT NOT NULL DEFAULT '',
    minutes     INTEGER NOT NULL,
    difficulty  TEXT NOT NULL,
    servings    INTEGER NOT NULL,
    tags        TEXT[] NOT NULL DEFAULT '{}',
    summary     TEXT NOT NULL DEFAULT '',
    steps       TEXT[] NOT NULL DEFAULT '{}'
  );

  /*
   * 레시피 재료는 ingredients 를 FK 로 걸지 않는다.
   * 밀가루·라면사리처럼 "냉장고에 없는" 재료도 레시피에는 등장해야 하기 때문이다.
   * 그래서 표시용 이름(ingredient_name)을 함께 저장한다.
   */
  CREATE TABLE IF NOT EXISTS recipe_ingredients (
    recipe_id       TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    ingredient_id   TEXT NOT NULL,
    ingredient_name TEXT NOT NULL,
    amount          TEXT NOT NULL,
    optional        BOOLEAN NOT NULL DEFAULT FALSE,
    position        INTEGER NOT NULL,
    PRIMARY KEY (recipe_id, ingredient_id)
  );
`;

/** 시드 데이터를 upsert 한다. 이미 있으면 덮어쓴다(재실행 안전). */
async function seedData(client) {
  for (const i of SEED_INGREDIENTS) {
    await client.query(
      `INSERT INTO ingredients (id, name, category, quantity, unit, storage, purchased_on, expires_on, tags, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, category=EXCLUDED.category, quantity=EXCLUDED.quantity,
         unit=EXCLUDED.unit, storage=EXCLUDED.storage, purchased_on=EXCLUDED.purchased_on,
         expires_on=EXCLUDED.expires_on, tags=EXCLUDED.tags, note=EXCLUDED.note`,
      [i.id, i.name, i.category, i.quantity, i.unit, i.storage, i.purchasedOn, i.expiresOn, i.tags, i.note]
    );
  }

  const nameOf = new Map(SEED_INGREDIENTS.map((i) => [i.id, i.name]));

  for (const r of SEED_RECIPES) {
    await client.query(
      `INSERT INTO recipes (id, name, emoji, minutes, difficulty, servings, tags, summary, steps)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, emoji=EXCLUDED.emoji, minutes=EXCLUDED.minutes,
         difficulty=EXCLUDED.difficulty, servings=EXCLUDED.servings, tags=EXCLUDED.tags,
         summary=EXCLUDED.summary, steps=EXCLUDED.steps`,
      [r.id, r.name, r.emoji, r.minutes, r.difficulty, r.servings, r.tags, r.summary, r.steps]
    );

    await client.query('DELETE FROM recipe_ingredients WHERE recipe_id = $1', [r.id]);

    for (let pos = 0; pos < r.ingredients.length; pos++) {
      const ref = r.ingredients[pos];
      const displayName = nameOf.get(ref.id) || PANTRY_NAMES[ref.id] || ref.id;
      await client.query(
        `INSERT INTO recipe_ingredients (recipe_id, ingredient_id, ingredient_name, amount, optional, position)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [r.id, ref.id, displayName, ref.amount, Boolean(ref.optional), pos]
      );
    }
  }
}

/**
 * Lazy init — 서버리스에서는 cold start 마다 불릴 수 있으므로 flag 로 중복 실행을 막는다.
 * 테이블이 비어 있을 때만 시드한다(사용자가 지운 데이터를 되살리지 않기 위함).
 */
let dbReady = false;
async function initDB() {
  if (dbReady) return;

  const client = await pool.connect();
  try {
    await client.query(SCHEMA_SQL);
    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM recipes');
    if (rows[0].n === 0) {
      console.log('[db] 레시피 테이블이 비어 있어 초기 데이터를 적재합니다...');
      await seedData(client);
      console.log('[db] 시드 완료');
    }
    dbReady = true;
  } finally {
    client.release();
  }
}

// ── Middleware ───────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// /api 요청 전에 스키마가 준비되어 있는지 보장한다
app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('[db] init 실패:', err.message);
    res.status(503).json({
      success: false,
      message: 'DB 연결에 실패했습니다. .env 의 DATABASE_URL 을 확인하세요.',
      detail: err.message,
    });
  }
});

// ── 공통 조회 SQL ────────────────────────────────────────────────
// DATE 를 문자열로 캐스팅해 타임존 보정 없이 'YYYY-MM-DD' 그대로 내보낸다.
const INGREDIENT_COLUMNS = `
  id, name, category,
  quantity::float8 AS quantity,
  unit, storage,
  to_char(purchased_on, 'YYYY-MM-DD') AS "purchasedOn",
  to_char(expires_on,   'YYYY-MM-DD') AS "expiresOn",
  tags, note
`;

/** 재료 입력값 검증. 문제가 없으면 정규화된 값을, 있으면 message 를 돌려준다. */
function validateIngredient(body) {
  const { name, category, quantity, unit, storage, purchasedOn, expiresOn, tags, note } = body || {};

  if (!name || !String(name).trim()) return { message: 'name 은 필수입니다.' };
  if (!category) return { message: 'category 는 필수입니다.' };
  if (!unit) return { message: 'unit 은 필수입니다.' };
  if (!storage) return { message: 'storage 는 필수입니다.' };

  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) return { message: 'quantity 는 0보다 큰 숫자여야 합니다.' };

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!expiresOn || !dateRe.test(expiresOn)) return { message: 'expiresOn 은 YYYY-MM-DD 형식이어야 합니다.' };
  if (purchasedOn && !dateRe.test(purchasedOn)) return { message: 'purchasedOn 은 YYYY-MM-DD 형식이어야 합니다.' };

  return {
    value: {
      name: String(name).trim(),
      category: String(category),
      quantity: qty,
      unit: String(unit),
      storage: String(storage),
      purchasedOn: purchasedOn || new Date().toISOString().slice(0, 10),
      expiresOn,
      tags: Array.isArray(tags) ? tags.map(String) : [],
      note: note ? String(note).trim() : '',
    },
  };
}

// ── API: 재료 ────────────────────────────────────────────────────

app.get('/api/ingredients', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${INGREDIENT_COLUMNS} FROM ingredients ORDER BY expires_on ASC, name ASC`
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

app.get('/api/ingredients/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${INGREDIENT_COLUMNS} FROM ingredients WHERE id = $1`, [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '재료를 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
});

app.post('/api/ingredients', async (req, res, next) => {
  try {
    const { value, message } = validateIngredient(req.body);
    if (message) return res.status(400).json({ success: false, message });

    const id = `custom-${Date.now()}`;
    const { rows } = await pool.query(
      `INSERT INTO ingredients (id, name, category, quantity, unit, storage, purchased_on, expires_on, tags, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING ${INGREDIENT_COLUMNS}`,
      [id, value.name, value.category, value.quantity, value.unit, value.storage,
       value.purchasedOn, value.expiresOn, value.tags, value.note]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
});

app.patch('/api/ingredients/:id', async (req, res, next) => {
  try {
    const { value, message } = validateIngredient(req.body);
    if (message) return res.status(400).json({ success: false, message });

    const { rows } = await pool.query(
      `UPDATE ingredients SET
         name=$2, category=$3, quantity=$4, unit=$5, storage=$6,
         purchased_on=$7, expires_on=$8, tags=$9, note=$10
       WHERE id = $1
       RETURNING ${INGREDIENT_COLUMNS}`,
      [req.params.id, value.name, value.category, value.quantity, value.unit, value.storage,
       value.purchasedOn, value.expiresOn, value.tags, value.note]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '재료를 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
});

app.delete('/api/ingredients/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM ingredients WHERE id = $1', [req.params.id]);
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: '재료를 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: { id: req.params.id } });
  } catch (err) { next(err); }
});

// ── API: 레시피 ──────────────────────────────────────────────────

/** 레시피 + 재료를 한 번에 읽어 클라이언트가 쓰던 형태로 조립한다. */
async function fetchRecipes(whereId) {
  const params = whereId ? [whereId] : [];
  const { rows } = await pool.query(
    `SELECT
       r.id, r.name, r.emoji, r.minutes, r.difficulty, r.servings, r.tags, r.summary, r.steps,
       COALESCE(
         json_agg(
           json_build_object(
             'id', ri.ingredient_id,
             'name', ri.ingredient_name,
             'amount', ri.amount,
             'optional', ri.optional
           ) ORDER BY ri.position
         ) FILTER (WHERE ri.ingredient_id IS NOT NULL),
         '[]'
       ) AS ingredients
     FROM recipes r
     LEFT JOIN recipe_ingredients ri ON ri.recipe_id = r.id
     ${whereId ? 'WHERE r.id = $1' : ''}
     GROUP BY r.id
     ORDER BY r.minutes ASC, r.name ASC`,
    params
  );
  return rows;
}

app.get('/api/recipes', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await fetchRecipes() });
  } catch (err) { next(err); }
});

app.get('/api/recipes/:id', async (req, res, next) => {
  try {
    const rows = await fetchRecipes(req.params.id);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '레시피를 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
});

// ── API: 헬스체크 ────────────────────────────────────────────────
app.get('/api/health', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM ingredients) AS ingredients,
         (SELECT COUNT(*)::int FROM recipes) AS recipes,
         (SELECT COUNT(*)::int FROM recipe_ingredients) AS recipe_ingredients`
    );
    res.json({ success: true, data: { db: 'connected', counts: rows[0] } });
  } catch (err) { next(err); }
});

// ── SPA fallback (Express 5 문법) ────────────────────────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ success: false, message: '서버 내부 오류가 발생했습니다.' });
});

// ── Startup & export ─────────────────────────────────────────────
if (require.main === module) {
  // node server.js --seed  →  스키마 생성 + 시드만 수행하고 종료
  if (process.argv.includes('--seed')) {
    (async () => {
      const client = await pool.connect();
      try {
        console.log('[seed] 스키마 생성 중...');
        await client.query(SCHEMA_SQL);
        console.log('[seed] 데이터 적재 중...');
        await seedData(client);
        const { rows } = await client.query(
          `SELECT
             (SELECT COUNT(*)::int FROM ingredients) AS ingredients,
             (SELECT COUNT(*)::int FROM recipes) AS recipes,
             (SELECT COUNT(*)::int FROM recipe_ingredients) AS recipe_ingredients`
        );
        console.log('[seed] 완료:', rows[0]);
      } catch (err) {
        console.error('[seed] 실패:', err.message);
        process.exitCode = 1;
      } finally {
        client.release();
        await pool.end();
      }
    })();
  } else {
    app.listen(PORT, () => {
      console.log(`냉장고 파먹기 서버 → http://localhost:${PORT}`);
    });
  }
}

module.exports = app;
