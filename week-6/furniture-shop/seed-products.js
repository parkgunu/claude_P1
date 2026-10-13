// 데모 상품 데이터를 gy_products 테이블에 넣는다 (id 기준 upsert — 여러 번 실행해도 안전).
// 사용: node seed-products.js
const path = require('path');
const { Pool } = require('pg');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const PRODUCTS = [
  { id: 'coaster-01', name: '결 원목 코스터 (결제 테스트용)', en: 'Gyeol Coaster', category: 'table', price: 100, badge: 'New', material: '오크 원목', size: 'Ø10 × H1 cm', colors: ['#D6BF9C'], freeShipping: true, description: '결제 테스트를 위한 100원 상품입니다. 오크 원목을 둥글게 깎아 만든 작은 코스터.' },
  { id: 'sofa-01', name: '뭉게 3인 소파', en: 'Mounge Sofa', category: 'sofa', price: 2890000, badge: 'Best', material: '부클레 패브릭, 원목 프레임', size: 'W240 × D98 × H72 cm', colors: ['#E8DFD1', '#B9AE9C'], description: '구름처럼 둥근 팔걸이와 깊은 좌방석. 하루의 끝에 몸을 맡기기 좋은, 낮고 넉넉한 3인 소파입니다.' },
  { id: 'sofa-02', name: '숲 2인 소파', en: 'Soop Loveseat', category: 'sofa', price: 1690000, badge: 'New', material: '린넨, 월넛 다리', size: 'W168 × D86 × H78 cm', colors: ['#A9B29A', '#E6E0D4'], description: '세이지 그린 린넨과 가는 월넛 다리. 작은 거실에도 가볍게 놓이는 2인용 소파.' },
  { id: 'chair-01', name: '곡 라운지 체어', en: 'Gok Lounge Chair', category: 'chair', price: 1240000, badge: null, material: '베지터블 가죽, 오크', size: 'W72 × D80 × H74 cm', colors: ['#A6704B', '#3B2E25'], description: '한 장의 곡선으로 이어지는 오크 프레임 위에 코냑 가죽을 얹었습니다. 시간이 지날수록 깊어지는 색.' },
  { id: 'chair-02', name: '엮음 다이닝 체어', en: 'Yeokkeum Chair', category: 'chair', price: 340000, badge: 'Best', material: '애쉬 원목, 페이퍼 코드', size: 'W46 × D50 × H78 cm', colors: ['#D9C7A8', '#2B2A28'], description: '손으로 엮은 페이퍼 코드 좌판. 가볍고 단단해 매일 쓰는 식탁 의자로 알맞습니다.' },
  { id: 'table-01', name: '둥근 다이닝 테이블', en: 'Dunggeun Table', category: 'table', price: 1480000, badge: null, material: '화이트 오크 원목', size: 'Ø120 × H74 cm', colors: ['#D6BF9C'], description: '하나의 기둥이 받치는 원형 상판. 다리에 걸리지 않아 네 사람이 편히 둘러앉습니다.' },
  { id: 'table-02', name: '물결 커피 테이블', en: 'Mulgyeol Coffee Table', category: 'table', price: 1150000, badge: 'New', material: '트래버틴 천연석', size: 'W110 × D60 × H32 cm', colors: ['#E3D6C2'], description: '모서리를 부드럽게 굴린 트래버틴 상판. 돌마다 다른 결이 하나뿐인 테이블을 만듭니다.' },
  { id: 'storage-01', name: '골 사이드보드', en: 'Gol Sideboard', category: 'storage', price: 1980000, badge: null, material: '월넛 원목, 플루티드 도어', size: 'W180 × D45 × H62 cm', colors: ['#5C4033'], description: '세로 홈이 새겨진 슬라이딩 도어. 빛이 지나갈 때마다 표면에 리듬이 생깁니다.' },
  { id: 'storage-02', name: '켜 책장', en: 'Kyeo Bookshelf', category: 'storage', price: 690000, badge: null, material: '화이트 오크', size: 'W80 × D32 × H190 cm', colors: ['#D6BF9C', '#F1EEE8'], description: '다섯 칸의 오픈 선반. 책과 오브제를 켜켜이 쌓아 벽 한 면을 채워보세요.' },
  { id: 'bed-01', name: '쉼 플랫폼 침대', en: 'Swim Platform Bed', category: 'bed', price: 1790000, badge: 'Best', material: '패브릭 헤드보드, 원목 프레임', size: 'Queen · W170 × D215 × H95 cm', colors: ['#B8B2A8', '#E8E2D8'], description: '바닥에 가깝게 내려앉은 낮은 프레임과 도톰한 헤드보드. 방 전체가 차분해집니다.' },
  { id: 'lamp-01', name: '달 플로어 램프', en: 'Dal Floor Lamp', category: 'lighting', price: 420000, badge: null, material: '한지 쉐이드, 스틸', size: 'Ø50 × H160 cm', colors: ['#F3EEE4'], description: '종이를 통과한 빛은 부드럽게 번집니다. 저녁의 거실에 띄운 작은 달.' },
  { id: 'lamp-02', name: '버섯 테이블 램프', en: 'Beoseot Table Lamp', category: 'lighting', price: 198000, badge: 'New', material: '무광 세라믹', size: 'Ø30 × H34 cm', colors: ['#EDE6D8', '#C9A27E'], description: '둥근 갓과 짧은 기둥. 침대 옆, 책상 위 어디에 두어도 귀여운 세라믹 램프.' },
  { id: 'stool-01', name: '세발 스툴', en: 'Sebal Stool', category: 'chair', price: 159000, badge: null, material: '오크 원목', size: 'Ø34 × H45 cm', colors: ['#D6BF9C', '#3B2E25'], description: '세 개의 다리로 어디서든 흔들림 없이. 의자로, 사이드 테이블로, 화분대로.' },
];

(async () => {
  const pool = new Pool({ connectionString: (process.env.DATABASE_URL || '').trim(), ssl: { rejectUnauthorized: false } });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gy_products (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      en          TEXT NOT NULL,
      category    TEXT NOT NULL,
      price       INTEGER NOT NULL CHECK (price >= 0),
      badge       TEXT,
      material    TEXT,
      size        TEXT,
      colors      JSONB NOT NULL DEFAULT '[]',
      description TEXT,
      image       TEXT NOT NULL,
      sort_order  INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query("ALTER TABLE gy_products ADD COLUMN IF NOT EXISTS free_shipping BOOLEAN NOT NULL DEFAULT FALSE");
  for (const [i, p] of PRODUCTS.entries()) {
    await pool.query(
      `INSERT INTO gy_products (id, name, en, category, price, badge, material, size, colors, description, image, sort_order, free_shipping)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, en=EXCLUDED.en, category=EXCLUDED.category, price=EXCLUDED.price,
         badge=EXCLUDED.badge, material=EXCLUDED.material, size=EXCLUDED.size, colors=EXCLUDED.colors,
         description=EXCLUDED.description, image=EXCLUDED.image, sort_order=EXCLUDED.sort_order, free_shipping=EXCLUDED.free_shipping`,
      [p.id, p.name, p.en, p.category, p.price, p.badge, p.material, p.size, JSON.stringify(p.colors), p.description, `images/${p.id}.jpg`, i, !!p.freeShipping],
    );
  }
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM gy_products');
  console.log(`gy_products: ${rows[0].n}개`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
