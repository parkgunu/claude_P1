// 레시피 재료 문자열("다진 소고기 200g")에서 칼로리를 추정한다.
// 식품성분표 대표값을 100g 기준으로 반올림한 근사치라, 화면에도 '약' 을 붙여 보여 준다.

// kcal: 100g 당 열량 / def: 분량이 없거나 개수 단위 1개의 기본 무게(g) / units: 이 재료만의 단위 무게(g)
const FOODS = {
  // 육류·해산물
  소고기: { kcal: 250, def: 150, units: { 근: 600 } },
  돼지고기: { kcal: 260, def: 150, units: { 근: 600 } },
  삼겹살: { kcal: 330, def: 150 },
  목살: { kcal: 220, def: 150 },
  차돌박이: { kcal: 330, def: 100 },
  닭가슴살: { kcal: 110, def: 100, units: { 쪽: 100, 덩어리: 100 } },
  닭다리: { kcal: 180, def: 90, units: { 개: 90 } },
  닭고기: { kcal: 160, def: 120, units: { 마리: 900 } },
  베이컨: { kcal: 400, def: 15, units: { 줄: 15, 장: 15 } },
  햄: { kcal: 300, def: 30, units: { 장: 20, 캔: 200 } },
  소시지: { kcal: 300, def: 40, units: { 개: 40 } },
  스팸: { kcal: 320, def: 100, units: { 캔: 200 } },
  새우: { kcal: 100, def: 100, units: { 마리: 15 } },
  오징어: { kcal: 90, def: 200, units: { 마리: 200 } },
  고등어: { kcal: 180, def: 150, units: { 마리: 300 } },
  연어: { kcal: 200, def: 120 },
  참치: { kcal: 130, def: 100, units: { 캔: 100 } },
  멸치: { kcal: 330, def: 10, units: { 줌: 10, 컵: 40 } },
  바지락: { kcal: 70, def: 150 },

  // 유제품·계란
  계란: { kcal: 143, def: 50, units: { 개: 50, 알: 50 } },
  달걀: { kcal: 143, def: 50, units: { 개: 50, 알: 50 } },
  메추리알: { kcal: 160, def: 10, units: { 개: 10 } },
  우유: { kcal: 62, def: 200, units: { 컵: 200, 개: 200 } },
  체다치즈: { kcal: 400, def: 20, units: { 장: 20 } },
  모짜렐라: { kcal: 300, def: 50, units: { 컵: 100 } },
  치즈: { kcal: 380, def: 20, units: { 장: 20 } },
  버터: { kcal: 720, def: 10, units: { 큰술: 13, 조각: 10 } },
  생크림: { kcal: 340, def: 100 },
  요거트: { kcal: 60, def: 85, units: { 개: 85, 컵: 200 } },

  // 곡류·면·빵
  밥: { kcal: 150, def: 210, units: { 공기: 210, 컵: 210 } },
  쌀: { kcal: 360, def: 150, units: { 컵: 160 } },
  떡국떡: { kcal: 220, def: 150 },
  떡볶이떡: { kcal: 220, def: 150 },
  떡: { kcal: 220, def: 100 },
  식빵: { kcal: 270, def: 35, units: { 장: 35 } },
  바게트: { kcal: 270, def: 60, units: { 개: 250, 조각: 30 } },
  또띠아: { kcal: 300, def: 45, units: { 장: 45 } },
  라면: { kcal: 440, def: 120, units: { 개: 120, 봉: 120 } },
  소면: { kcal: 360, def: 100, units: { 줌: 80 } },
  스파게티: { kcal: 370, def: 100, units: { 줌: 80 } },
  우동면: { kcal: 130, def: 200, units: { 개: 200, 봉: 200 } },
  당면: { kcal: 350, def: 50, units: { 줌: 40 } },
  밀가루: { kcal: 360, def: 100, units: { 큰술: 8, 컵: 110 } },
  부침가루: { kcal: 360, def: 100, units: { 큰술: 8, 컵: 110 } },
  빵가루: { kcal: 380, def: 30, units: { 큰술: 5, 컵: 50 } },

  // 채소·과일
  양파: { kcal: 40, def: 200, units: { 개: 200 } },
  대파: { kcal: 35, def: 100, units: { 대: 100, 뿌리: 100 } },
  쪽파: { kcal: 35, def: 10, units: { 대: 10, 줌: 30 } },
  마늘: { kcal: 130, def: 5, units: { 쪽: 5, 개: 5, 통: 50, 큰술: 15 } },
  생강: { kcal: 80, def: 5, units: { 쪽: 5, 큰술: 15 } },
  감자: { kcal: 77, def: 150, units: { 개: 150 } },
  고구마: { kcal: 130, def: 150, units: { 개: 150 } },
  당근: { kcal: 40, def: 150, units: { 개: 150 } },
  애호박: { kcal: 20, def: 250, units: { 개: 250 } },
  호박: { kcal: 30, def: 250, units: { 개: 250 } },
  오이: { kcal: 15, def: 200, units: { 개: 200 } },
  가지: { kcal: 25, def: 150, units: { 개: 150 } },
  양배추: { kcal: 25, def: 100, units: { 개: 1000, 통: 1000, 포기: 1000, 장: 40 } },
  배추: { kcal: 15, def: 200, units: { 포기: 2000, 장: 80 } },
  상추: { kcal: 15, def: 30, units: { 장: 5, 줌: 30 } },
  시금치: { kcal: 25, def: 100, units: { 줌: 50, 단: 300 } },
  콩나물: { kcal: 30, def: 100, units: { 줌: 50, 봉: 300 } },
  숙주: { kcal: 25, def: 100, units: { 줌: 50, 봉: 300 } },
  버섯: { kcal: 25, def: 50, units: { 개: 20, 줌: 50, 봉: 150 } },
  파프리카: { kcal: 30, def: 150, units: { 개: 150 } },
  청양고추: { kcal: 30, def: 10, units: { 개: 10 } },
  고추: { kcal: 30, def: 12, units: { 개: 12 } },
  방울토마토: { kcal: 18, def: 15, units: { 개: 15, 줌: 90 } },
  토마토: { kcal: 18, def: 180, units: { 개: 180 } },
  사과: { kcal: 52, def: 200, units: { 개: 200 } },
  바나나: { kcal: 90, def: 120, units: { 개: 120 } },
  레몬: { kcal: 30, def: 100, units: { 개: 100 } },
  아보카도: { kcal: 160, def: 150, units: { 개: 150 } },
  옥수수: { kcal: 100, def: 150, units: { 개: 150, 캔: 150 } },
  김치: { kcal: 30, def: 150, units: { 컵: 150, 포기: 800, 줌: 60 } },
  단무지: { kcal: 15, def: 50 },
  김: { kcal: 180, def: 3, units: { 장: 3, 봉: 20 } },
  미역: { kcal: 130, def: 10, units: { 줌: 10, 컵: 15 } },

  // 콩·두부
  두부: { kcal: 80, def: 300, units: { 모: 300, 팩: 300 } },
  유부: { kcal: 380, def: 10, units: { 장: 10 } },

  // 양념·기름
  소금: { kcal: 0, def: 5 },
  후추: { kcal: 0, def: 1 },
  설탕: { kcal: 400, def: 12, units: { 큰술: 12, 작은술: 4, 컵: 180 } },
  물엿: { kcal: 300, def: 20, units: { 큰술: 20 } },
  올리고당: { kcal: 250, def: 20, units: { 큰술: 20 } },
  꿀: { kcal: 300, def: 20, units: { 큰술: 20 } },
  간장: { kcal: 53, def: 18, units: { 큰술: 18, 작은술: 6, 컵: 230 } },
  고추장: { kcal: 230, def: 18, units: { 큰술: 18, 작은술: 6 } },
  된장: { kcal: 190, def: 18, units: { 큰술: 18, 작은술: 6 } },
  쌈장: { kcal: 200, def: 18, units: { 큰술: 18 } },
  고춧가루: { kcal: 300, def: 7, units: { 큰술: 7, 작은술: 2, 컵: 80 } },
  참기름: { kcal: 900, def: 13, units: { 큰술: 13, 작은술: 4, 컵: 200 } },
  들기름: { kcal: 900, def: 13, units: { 큰술: 13, 작은술: 4 } },
  올리브유: { kcal: 880, def: 13, units: { 큰술: 13, 작은술: 4, 컵: 200 } },
  식용유: { kcal: 880, def: 13, units: { 큰술: 13, 작은술: 4, 컵: 200 } },
  마요네즈: { kcal: 700, def: 13, units: { 큰술: 13, 작은술: 4 } },
  케찹: { kcal: 110, def: 15, units: { 큰술: 15 } },
  케첩: { kcal: 110, def: 15, units: { 큰술: 15 } },
  머스타드: { kcal: 150, def: 15, units: { 큰술: 15 } },
  식초: { kcal: 20, def: 15, units: { 큰술: 15 } },
  맛술: { kcal: 130, def: 15, units: { 큰술: 15 } },
  미림: { kcal: 130, def: 15, units: { 큰술: 15 } },
  청주: { kcal: 130, def: 15, units: { 큰술: 15 } },
  굴소스: { kcal: 120, def: 18, units: { 큰술: 18 } },
  액젓: { kcal: 50, def: 15, units: { 큰술: 15 } },
  참깨: { kcal: 570, def: 5, units: { 큰술: 8, 작은술: 3 } },
  깨: { kcal: 570, def: 5, units: { 큰술: 8, 작은술: 3 } },

  // 기타
  물: { kcal: 0, def: 200, units: { 컵: 200 } },
  육수: { kcal: 5, def: 200, units: { 컵: 200 } },
  다시다: { kcal: 200, def: 5, units: { 큰술: 10, 작은술: 3 } },
};

// 표에 없는 재료를 이름만 보고 대략 묶어 준다 (위에서부터 먼저 맞는 것)
const FALLBACKS = [
  [/고기|살코기|정육/, { kcal: 230, def: 120 }],
  [/버섯/, { kcal: 25, def: 50 }],
  [/기름$/, { kcal: 880, def: 13, units: { 큰술: 13, 작은술: 4 } }],
  [/가루$/, { kcal: 360, def: 50, units: { 큰술: 8, 작은술: 3 } }],
  [/소스$|양념$/, { kcal: 150, def: 18, units: { 큰술: 18, 작은술: 6 } }],
];

// 이름이 긴 것부터 맞춰야 '고추장' 이 '고추' 로 잡히지 않는다
const FOOD_KEYS = Object.keys(FOODS).sort((a, b) => b.length - a.length);

// 재료와 상관없이 무게/부피가 정해지는 단위
const UNIT_G = {
  g: 1, kg: 1000, mg: 0.001, ml: 1, cc: 1, l: 1000, 리터: 1000,
  큰술: 15, 스푼: 15, 숟가락: 15, 작은술: 5, 티스푼: 5,
  컵: 200, 공기: 210, 줌: 20, 조각: 30, 꼬집: 0.5, 인분: 150,
};

// 재료마다 무게가 달라서 FOODS.units 나 def 를 봐야 하는 단위
const COUNT_UNITS = ['개', '알', '쪽', '장', '줄', '대', '모', '마리', '봉', '통', '포기', '뿌리', '단', '줄기', '판', '팩', '캔', '근', '덩어리'];

// 숫자 뒤에 올 수 있는 단위를 긴 것부터 (부분 일치로 자르기 때문)
const ALL_UNITS = [...Object.keys(UNIT_G), ...COUNT_UNITS].sort((a, b) => b.length - a.length);

const KO_NUM = { 반: 0.5, 한: 1, 두: 2, 세: 3, 석: 3, 네: 4, 넉: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };
// '두부' 의 '두' 를 숫자 2 로 읽지 않도록, 한글 수량은 뒤에 단위가 붙은 경우만 인정한다
const KO_NUM_RE = new RegExp(`(${Object.keys(KO_NUM).join('|')})\\s*(${ALL_UNITS.join('|')})`);
const NUM_RE = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)/;
const VAGUE_RE = /약간|조금|적당량|살짝|톡톡|취향/;

const normalize = (s) => String(s).replace(/\s+/g, '').toLowerCase();

// 숫자 뒤에 붙은 글자에서 단위만 떼어 낸다 ('200g짜리' → 'g')
const matchUnit = (rest) => ALL_UNITS.find((u) => rest.startsWith(u)) || null;

// "다진소고기200g" → { amount: 200, unit: 'g' } / 못 읽으면 null
function parseAmount(text) {
  const num = NUM_RE.exec(text);
  if (num) {
    const amount = num[1] ? Number(num[1]) / Number(num[2]) : Number(num[3]);
    return { amount, unit: matchUnit(text.slice(num.index + num[0].length)) };
  }
  const ko = KO_NUM_RE.exec(text);
  if (ko) return { amount: KO_NUM[ko[1]], unit: ko[2] };
  return null;
}

function findFood(name) {
  const key = FOOD_KEYS.find((k) => name.includes(k));
  if (key) return FOODS[key];
  const hit = FALLBACKS.find(([re]) => re.test(name));
  return hit ? hit[1] : null;
}

// 재료 한 줄 → { kcal, grams, assumed } / 모르는 재료면 null
function estimateOne(text) {
  const name = normalize(text);
  const food = findFood(name);
  if (!food) return null;

  const parsed = parseAmount(name);
  let grams;
  let assumed = false;

  if (!parsed) {
    // "소금 약간" 도, 분량이 아예 없는 "식빵" 도 기본값으로 본다
    grams = VAGUE_RE.test(name) ? Math.min(food.def, 5) : food.def;
    assumed = true;
  } else {
    const { amount, unit } = parsed;
    const per = unit ? (food.units && food.units[unit]) || UNIT_G[unit] : null;
    if (per != null) {
      grams = amount * per;
    } else if (!unit || COUNT_UNITS.includes(unit)) {
      grams = amount * food.def; // 개수 단위인데 표에 없으면 기본 무게로 센다
      assumed = true;
    } else {
      return null;
    }
  }

  return { kcal: Math.round((grams * food.kcal) / 100), grams: Math.round(grams), assumed };
}

/**
 * 레시피 재료 배열 → 칼로리 추정
 * items 는 재료와 같은 순서이고, 추정하지 못한 재료는 null 이다.
 */
function estimateCalories(ingredients) {
  const items = (Array.isArray(ingredients) ? ingredients : []).map((text) => {
    try {
      return estimateOne(text);
    } catch (_err) {
      return null; // 한 줄 때문에 레시피 전체가 깨지지 않게 한다
    }
  });

  const known = items.filter(Boolean);
  const sum = known.reduce((acc, it) => acc + it.kcal, 0);

  return {
    // 어차피 근사치라 10 단위로 끊는다
    total: sum >= 100 ? Math.round(sum / 10) * 10 : Math.round(sum / 5) * 5,
    unknown: items.length - known.length,
    assumed: known.some((it) => it.assumed),
    items,
  };
}

module.exports = { estimateCalories };
