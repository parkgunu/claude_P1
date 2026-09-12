const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 스프라이트 호스트. 나중에 이미지를 직접 보유하면 '/sprites' 같은 로컬 경로로 바꾸면 된다.
const SPRITE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';
const artworkUrl = (id) => `${SPRITE_BASE}/other/official-artwork/${id}.png`;
const spriteUrl = (id) => `${SPRITE_BASE}/${id}.png`;

// ── In-memory store ──────────────────────────────────────────────

// 타입 마스터 (PokeAPI 와 같은 id 체계를 유지해 상성표 계산을 단순하게 둔다)
const TYPES = [
  { id: 1, slug: 'normal', label: '노말' },
  { id: 2, slug: 'fighting', label: '격투' },
  { id: 3, slug: 'flying', label: '비행' },
  { id: 4, slug: 'poison', label: '독' },
  { id: 5, slug: 'ground', label: '땅' },
  { id: 6, slug: 'rock', label: '바위' },
  { id: 7, slug: 'bug', label: '벌레' },
  { id: 8, slug: 'ghost', label: '고스트' },
  { id: 9, slug: 'steel', label: '강철' },
  { id: 10, slug: 'fire', label: '불꽃' },
  { id: 11, slug: 'water', label: '물' },
  { id: 12, slug: 'grass', label: '풀' },
  { id: 13, slug: 'electric', label: '전기' },
  { id: 14, slug: 'psychic', label: '에스퍼' },
  { id: 15, slug: 'ice', label: '얼음' },
  { id: 16, slug: 'dragon', label: '드래곤' },
  { id: 17, slug: 'dark', label: '악' },
  { id: 18, slug: 'fairy', label: '페어리' },
];

const TYPE_BY_SLUG = new Map(TYPES.map((t) => [t.slug, t]));

// 공격 타입 → 방어 타입별 배율 (6세대 이후 기준). 1배는 생략한다.
const TYPE_CHART = {
  normal: { x2: [], half: ['rock', 'steel'], zero: ['ghost'] },
  fighting: { x2: ['normal', 'rock', 'steel', 'ice', 'dark'], half: ['flying', 'poison', 'bug', 'psychic', 'fairy'], zero: ['ghost'] },
  flying: { x2: ['fighting', 'bug', 'grass'], half: ['rock', 'steel', 'electric'], zero: [] },
  poison: { x2: ['grass', 'fairy'], half: ['poison', 'ground', 'rock', 'ghost'], zero: ['steel'] },
  ground: { x2: ['poison', 'rock', 'steel', 'fire', 'electric'], half: ['bug', 'grass'], zero: ['flying'] },
  rock: { x2: ['flying', 'bug', 'fire', 'ice'], half: ['fighting', 'ground', 'steel'], zero: [] },
  bug: { x2: ['grass', 'psychic', 'dark'], half: ['fighting', 'flying', 'poison', 'ghost', 'steel', 'fire', 'fairy'], zero: [] },
  ghost: { x2: ['ghost', 'psychic'], half: ['dark'], zero: ['normal'] },
  steel: { x2: ['rock', 'ice', 'fairy'], half: ['steel', 'fire', 'water', 'electric'], zero: [] },
  fire: { x2: ['bug', 'steel', 'grass', 'ice'], half: ['rock', 'fire', 'water', 'dragon'], zero: [] },
  water: { x2: ['ground', 'rock', 'fire'], half: ['water', 'grass', 'dragon'], zero: [] },
  grass: { x2: ['ground', 'rock', 'water'], half: ['flying', 'poison', 'bug', 'steel', 'fire', 'grass', 'dragon'], zero: [] },
  electric: { x2: ['flying', 'water'], half: ['grass', 'electric', 'dragon'], zero: ['ground'] },
  psychic: { x2: ['fighting', 'poison'], half: ['steel', 'psychic'], zero: ['dark'] },
  ice: { x2: ['flying', 'ground', 'grass', 'dragon'], half: ['steel', 'fire', 'water', 'ice'], zero: [] },
  dragon: { x2: ['dragon'], half: ['steel'], zero: ['fairy'] },
  dark: { x2: ['ghost', 'psychic'], half: ['fighting', 'dark', 'fairy'], zero: [] },
  fairy: { x2: ['fighting', 'dragon', 'dark'], half: ['poison', 'steel', 'fire'], zero: [] },
};

const STAT_LABELS = {
  hp: 'HP',
  attack: '공격',
  defense: '방어',
  'special-attack': '특수공격',
  'special-defense': '특수방어',
  speed: '스피드',
};
const STAT_ORDER = ['hp', 'attack', 'defense', 'special-attack', 'special-defense', 'speed'];

// 진화 라인 (도감번호 순). 서버에 없는 번호는 응답할 때 걸러낸다.
const EVOLUTION_CHAINS = [
  [1, 2, 3],
  [4, 5, 6],
  [7, 8, 9],
  [10, 11, 12],
];

// 포켓몬 원본 데이터 — 우선 10마리
let pokemons = [
  {
    id: 1, slug: 'bulbasaur', name: '쑥쑥씨', genus: '씨앗포켓몬', generation: 1,
    height: 0.7, weight: 6.9, types: ['grass', 'poison'],
    stats: { hp: 45, attack: 49, defense: 49, 'special-attack': 65, 'special-defense': 65, speed: 45 },
    abilities: [{ name: '신록', isHidden: false }, { name: '엽록소', isHidden: true }],
    flavorText: '태어났을 때부터 등에 이상한 씨앗이 심어져 있으며 몸과 함께 자란다고 한다.',
    captureRate: 45, isLegendary: false, isMythical: false,
  },
  {
    id: 2, slug: 'ivysaur', name: '봉오리', genus: '씨앗포켓몬', generation: 1,
    height: 1.0, weight: 13.0, types: ['grass', 'poison'],
    stats: { hp: 60, attack: 62, defense: 63, 'special-attack': 80, 'special-defense': 80, speed: 60 },
    abilities: [{ name: '신록', isHidden: false }, { name: '엽록소', isHidden: true }],
    flavorText: '등의 봉오리가 커지면 두 다리로 서 있는 시간이 길어진다. 큰 꽃이 필 징조다.',
    captureRate: 45, isLegendary: false, isMythical: false,
  },
  {
    id: 3, slug: 'venusaur', name: '만개꽃', genus: '씨앗포켓몬', generation: 1,
    height: 2.0, weight: 100.0, types: ['grass', 'poison'],
    stats: { hp: 80, attack: 82, defense: 83, 'special-attack': 100, 'special-defense': 100, speed: 80 },
    abilities: [{ name: '신록', isHidden: false }, { name: '엽록소', isHidden: true }],
    flavorText: '등의 꽃이 태양 에너지를 흡수한다. 영양을 모으면 꽃의 색이 선명해진다.',
    captureRate: 45, isLegendary: false, isMythical: false,
  },
  {
    id: 4, slug: 'charmander', name: '불꼬리', genus: '도마뱀포켓몬', generation: 1,
    height: 0.6, weight: 8.5, types: ['fire'],
    stats: { hp: 39, attack: 52, defense: 43, 'special-attack': 60, 'special-defense': 50, speed: 65 },
    abilities: [{ name: '맹화', isHidden: false }, { name: '태양의힘', isHidden: true }],
    flavorText: '태어났을 때부터 꼬리에 불꽃이 타오른다. 불꽃이 꺼지면 생명이 끝난다고 전해진다.',
    captureRate: 45, isLegendary: false, isMythical: false,
  },
  {
    id: 5, slug: 'charmeleon', name: '화염톱', genus: '화염포켓몬', generation: 1,
    height: 1.1, weight: 19.0, types: ['fire'],
    stats: { hp: 58, attack: 64, defense: 58, 'special-attack': 80, 'special-defense': 65, speed: 80 },
    abilities: [{ name: '맹화', isHidden: false }, { name: '태양의힘', isHidden: true }],
    flavorText: '날카로운 손톱으로 적을 가른다. 강한 상대를 만나면 꼬리의 불꽃이 푸르게 타오른다.',
    captureRate: 45, isLegendary: false, isMythical: false,
  },
  {
    id: 6, slug: 'charizard', name: '창공룡', genus: '화염포켓몬', generation: 1,
    height: 1.7, weight: 90.5, types: ['fire', 'flying'],
    stats: { hp: 78, attack: 84, defense: 78, 'special-attack': 109, 'special-defense': 85, speed: 100 },
    abilities: [{ name: '맹화', isHidden: false }, { name: '태양의힘', isHidden: true }],
    flavorText: '강한 상대를 찾아 하늘을 난다. 내뿜는 불꽃은 무엇이든 녹여 버릴 만큼 뜨겁다.',
    captureRate: 45, isLegendary: false, isMythical: false,
  },
  {
    id: 7, slug: 'squirtle', name: '뽀글이', genus: '꼬마거북포켓몬', generation: 1,
    height: 0.5, weight: 9.0, types: ['water'],
    stats: { hp: 44, attack: 48, defense: 65, 'special-attack': 50, 'special-defense': 64, speed: 43 },
    abilities: [{ name: '급류', isHidden: false }, { name: '젖은접시', isHidden: true }],
    flavorText: '등껍질에 숨어 몸을 지킨다. 반격할 때는 입에서 세찬 거품을 내뿜는다.',
    captureRate: 45, isLegendary: false, isMythical: false,
  },
  {
    id: 8, slug: 'wartortle', name: '물보라', genus: '거북포켓몬', generation: 1,
    height: 1.0, weight: 22.5, types: ['water'],
    stats: { hp: 59, attack: 63, defense: 80, 'special-attack': 65, 'special-defense': 80, speed: 58 },
    abilities: [{ name: '급류', isHidden: false }, { name: '젖은접시', isHidden: true }],
    flavorText: '풍성한 꼬리는 장수의 상징이다. 헤엄칠 때는 균형을 잡는 키 역할을 한다.',
    captureRate: 45, isLegendary: false, isMythical: false,
  },
  {
    id: 9, slug: 'blastoise', name: '대포왕', genus: '조개포켓몬', generation: 1,
    height: 1.6, weight: 85.5, types: ['water'],
    stats: { hp: 79, attack: 83, defense: 100, 'special-attack': 85, 'special-defense': 105, speed: 78 },
    abilities: [{ name: '급류', isHidden: false }, { name: '젖은접시', isHidden: true }],
    flavorText: '등껍질의 분사구에서 고압의 물을 쏜다. 두꺼운 철판도 뚫을 정도의 위력이다.',
    captureRate: 45, isLegendary: false, isMythical: false,
  },
  {
    id: 10, slug: 'caterpie', name: '꿈틀이', genus: '벌레포켓몬', generation: 1,
    height: 0.3, weight: 2.9, types: ['bug'],
    stats: { hp: 45, attack: 30, defense: 35, 'special-attack': 20, 'special-defense': 20, speed: 45 },
    abilities: [{ name: '인분', isHidden: false }, { name: '도주', isHidden: true }],
    flavorText: '머리의 더듬이에서 강한 냄새를 풍겨 적을 쫓아낸다. 잎을 잘 먹어 순식간에 자란다.',
    captureRate: 255, isLegendary: false, isMythical: false,
  },
];

// ── Serializers ──────────────────────────────────────────────────

function toType(slug) {
  const t = TYPE_BY_SLUG.get(slug);
  return t ? { id: t.id, slug: t.slug, label: t.label } : { id: 0, slug, label: slug };
}

// 목록 카드용 표현. 화면이 그대로 쓰는 형태로 내려준다.
function toListItem(p) {
  const stats = STAT_ORDER
    .filter((key) => p.stats[key] !== undefined)
    .map((key) => ({ key, label: STAT_LABELS[key] || key, value: p.stats[key] }));

  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    genus: p.genus || '',
    generation: p.generation || 0,
    height: p.height,
    weight: p.weight,
    types: p.types.map(toType),
    stats,
    total: stats.reduce((sum, s) => sum + s.value, 0),
    artwork: artworkUrl(p.id),
    sprite: spriteUrl(p.id),
  };
}

// 상세 패널용 표현. 진화 라인은 서버에 실제로 있는 포켓몬만 남긴다.
function toDetail(p) {
  const chain = EVOLUTION_CHAINS.find((ids) => ids.includes(p.id)) || [p.id];
  const evolution = chain
    .map((id) => pokemons.find((x) => x.id === id))
    .filter(Boolean)
    .map((x) => ({ id: x.id, name: x.name }));

  return {
    abilities: p.abilities || [],
    flavorText: p.flavorText || '',
    captureRate: p.captureRate,
    isLegendary: !!p.isLegendary,
    isMythical: !!p.isMythical,
    evolution,
  };
}

// 1배가 아닌 조합만 ["공격타입id:방어타입id", 배율] 쌍으로 만든다.
function buildEfficacy() {
  const pairs = [];
  TYPES.forEach((attacker) => {
    const chart = TYPE_CHART[attacker.slug];
    if (!chart) return;
    const add = (slugs, factor) => {
      slugs.forEach((slug) => {
        const def = TYPE_BY_SLUG.get(slug);
        if (def) pairs.push([`${attacker.id}:${def.id}`, factor]);
      });
    };
    add(chart.x2, 2);
    add(chart.half, 0.5);
    add(chart.zero, 0);
  });
  return pairs;
}

// ── Middleware ───────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Validation ───────────────────────────────────────────────────

function validatePokemon(body, options) {
  const partial = !!(options && options.partial);
  const errors = [];
  const has = (key) => body[key] !== undefined;

  if (!partial && !has('name')) errors.push('name 은 필수입니다');
  if (has('name') && (typeof body.name !== 'string' || !body.name.trim())) {
    errors.push('name 은 비어 있지 않은 문자열이어야 합니다');
  }

  if (!partial && !has('types')) errors.push('types 는 필수입니다');
  if (has('types')) {
    if (!Array.isArray(body.types) || body.types.length < 1 || body.types.length > 2) {
      errors.push('types 는 1~2개짜리 배열이어야 합니다');
    } else {
      const unknown = body.types.filter((slug) => !TYPE_BY_SLUG.has(slug));
      if (unknown.length) errors.push(`알 수 없는 타입: ${unknown.join(', ')}`);
    }
  }

  if (!partial && !has('stats')) errors.push('stats 는 필수입니다');
  if (has('stats')) {
    if (typeof body.stats !== 'object' || body.stats === null) {
      errors.push('stats 는 객체여야 합니다');
    } else {
      STAT_ORDER.forEach((key) => {
        const value = body.stats[key];
        if (value === undefined) {
          if (!partial) errors.push(`stats.${key} 가 없습니다`);
          return;
        }
        if (!Number.isFinite(value) || value < 0 || value > 255) {
          errors.push(`stats.${key} 는 0~255 사이의 숫자여야 합니다`);
        }
      });
    }
  }

  ['height', 'weight'].forEach((key) => {
    if (!partial && !has(key)) errors.push(`${key} 는 필수입니다`);
    if (has(key) && (!Number.isFinite(body[key]) || body[key] <= 0)) {
      errors.push(`${key} 는 0 보다 큰 숫자여야 합니다`);
    }
  });

  return errors;
}

function applyBody(target, body) {
  const next = { ...target };

  ['name', 'slug', 'genus', 'flavorText'].forEach((key) => {
    if (typeof body[key] === 'string') next[key] = body[key].trim();
  });
  ['generation', 'height', 'weight', 'captureRate'].forEach((key) => {
    if (Number.isFinite(body[key])) next[key] = body[key];
  });
  ['isLegendary', 'isMythical'].forEach((key) => {
    if (typeof body[key] === 'boolean') next[key] = body[key];
  });
  if (Array.isArray(body.types)) next.types = body.types.slice();
  if (body.stats && typeof body.stats === 'object') next.stats = { ...next.stats, ...body.stats };
  if (Array.isArray(body.abilities)) {
    next.abilities = body.abilities
      .filter((a) => a && typeof a.name === 'string')
      .map((a) => ({ name: a.name.trim(), isHidden: !!a.isHidden }));
  }

  return next;
}

// ── API routes ───────────────────────────────────────────────────

// 부팅용: 목록 + 타입 + 상성표를 요청 1회로
app.get('/api/pokedex', (_req, res) => {
  res.json({
    success: true,
    data: {
      list: pokemons.map(toListItem),
      types: TYPES.map((t) => ({ id: t.id, slug: t.slug, label: t.label })),
      efficacy: buildEfficacy(),
    },
  });
});

app.get('/api/types', (_req, res) => {
  res.json({ success: true, data: { types: TYPES, efficacy: buildEfficacy() } });
});

app.get('/api/pokemon', (req, res) => {
  const { type, q } = req.query;
  let result = pokemons;

  if (type) result = result.filter((p) => p.types.includes(String(type)));
  if (q) {
    const keyword = String(q).toLowerCase();
    result = result.filter(
      (p) => p.name.toLowerCase().includes(keyword) || p.slug.toLowerCase().includes(keyword)
    );
  }

  res.json({ success: true, data: result.map(toListItem) });
});

app.get('/api/pokemon/:id', (req, res) => {
  const id = Number(req.params.id);
  const found = pokemons.find((p) => p.id === id);
  if (!found) return res.status(404).json({ success: false, message: '해당 도감번호의 포켓몬이 없습니다' });
  res.json({ success: true, data: { ...toListItem(found), detail: toDetail(found) } });
});

// 상세 패널 전용 (특성 · 도감 설명 · 진화 라인)
app.get('/api/pokemon/:id/detail', (req, res) => {
  const id = Number(req.params.id);
  const found = pokemons.find((p) => p.id === id);
  if (!found) return res.status(404).json({ success: false, message: '해당 도감번호의 포켓몬이 없습니다' });
  res.json({ success: true, data: toDetail(found) });
});

app.post('/api/pokemon', (req, res) => {
  const body = req.body || {};
  const errors = validatePokemon(body);
  if (errors.length) return res.status(400).json({ success: false, message: errors.join(' / ') });

  const id = Number.isFinite(body.id) ? body.id : Math.max(0, ...pokemons.map((p) => p.id)) + 1;
  if (pokemons.some((p) => p.id === id)) {
    return res.status(400).json({ success: false, message: `도감번호 ${id} 는 이미 등록되어 있습니다` });
  }

  const base = {
    id,
    slug: `pokemon-${id}`,
    name: '',
    genus: '',
    generation: 1,
    height: 1,
    weight: 1,
    types: [],
    stats: {},
    abilities: [],
    flavorText: '',
    captureRate: 255,
    isLegendary: false,
    isMythical: false,
  };
  const created = applyBody(base, body);
  pokemons.push(created);
  pokemons.sort((a, b) => a.id - b.id);

  res.status(201).json({ success: true, data: { ...toListItem(created), detail: toDetail(created) } });
});

app.put('/api/pokemon/:id', (req, res) => {
  const id = Number(req.params.id);
  const index = pokemons.findIndex((p) => p.id === id);
  if (index === -1) return res.status(404).json({ success: false, message: '해당 도감번호의 포켓몬이 없습니다' });

  const errors = validatePokemon(req.body || {}, { partial: true });
  if (errors.length) return res.status(400).json({ success: false, message: errors.join(' / ') });

  pokemons[index] = applyBody(pokemons[index], req.body || {});
  res.json({ success: true, data: { ...toListItem(pokemons[index]), detail: toDetail(pokemons[index]) } });
});

app.delete('/api/pokemon/:id', (req, res) => {
  const id = Number(req.params.id);
  const index = pokemons.findIndex((p) => p.id === id);
  if (index === -1) return res.status(404).json({ success: false, message: '해당 도감번호의 포켓몬이 없습니다' });

  const [removed] = pokemons.splice(index, 1);
  res.json({ success: true, data: { id: removed.id, name: removed.name } });
});

// ── SPA fallback (Express 5 문법) ────────────────────────────────

app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: '서버 내부 오류가 발생했습니다' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => console.log(`포켓몬 도감 서버 실행 중 → http://localhost:${PORT}`));
}
module.exports = app;
