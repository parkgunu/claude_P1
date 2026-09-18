require('dotenv').config();

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── fal.ai 설정 ──────────────────────────────────────────────────

// API 키는 서버에만 둔다. 클라이언트로 절대 내려보내지 않는다.
// Vercel 등에서 환경변수 끝에 개행이 붙는 경우가 있어 .trim() 을 건다.
const FAL_KEY = (process.env.FAL_KEY || '').trim();
const FAL_MODEL = 'fal-ai/flux/dev';
const FAL_ENDPOINT = `https://fal.run/${FAL_MODEL}`;
const FAL_TIMEOUT_MS = 120000;

// FLUX 는 영어 프롬프트를 훨씬 정확히 이해한다.
// 한글 입력은 이미지 생성 전에 영어 장면 묘사로 옮긴다.
const FAL_LLM_ENDPOINT = 'https://fal.run/fal-ai/any-llm';
const FAL_LLM_MODEL = 'google/gemini-flash-1.5';
const FAL_LLM_TIMEOUT_MS = 20000;
const TRANSLATE_SYSTEM_PROMPT = [
  'You rewrite a photo scene description into a vivid English phrase for an image generation model.',
  'Keep every concrete detail: subject, age, gender, action, objects, clothing, place.',
  'Do not add photographic style, camera, lens, film or lighting terms.',
  'Output ONLY the phrase - no quotes, no explanation.',
].join(' ');

const HANGUL = /[ㄱ-ㅎㅏ-ㅣ가-힣]/;

// 생성된 이미지가 호스팅되는 도메인 (다운로드 프록시 화이트리스트)
const ALLOWED_IMAGE_HOSTS = /(^|\.)fal\.media$/;

// ── 프리셋 정의 ──────────────────────────────────────────────────
// 클라이언트가 GET /api/presets 로 받아 그대로 렌더링한다.
// 프롬프트 조립 로직을 서버 한 곳에 모아두기 위함.

const LENSES = [
  { id: 'summilux35', label: '35mm Summilux', hint: '스트리트 · 표준 광각', prompt: 'shot on a Leica M11 with a 35mm Summilux f/1.4 lens' },
  { id: 'noctilux50', label: '50mm Noctilux', hint: '인물 · 극한의 보케', prompt: 'shot on a Leica M11 with a 50mm Noctilux f/0.95 lens, extremely shallow depth of field' },
  { id: 'elmarit28', label: '28mm Elmarit', hint: '풍경 · 넓은 화각', prompt: 'shot on a Leica Q3 with a 28mm Elmarit f/2.8 lens, wide angle' },
  { id: 'apo75', label: '75mm APO', hint: '망원 · 압축감', prompt: 'shot on a Leica M11 with a 75mm APO-Summicron f/2 lens, compressed telephoto perspective' },
];

const LOOKS = [
  { id: 'classic', label: '클래식 컬러', hint: '라이카 특유의 색감', prompt: 'classic Leica color rendering, rich but muted colors, deep blacks, high micro-contrast' },
  { id: 'mono', label: '모노크롬 흑백', hint: 'M Monochrom', prompt: 'black and white photograph taken with a Leica M11 Monochrom, deep rich blacks, silvery highlights, fine tonal gradation, no color' },
  { id: 'portra', label: '포트라 400', hint: '따뜻한 필름 톤', prompt: 'shot on Kodak Portra 400 film, warm pastel skin tones, soft creamy highlights, visible film grain' },
  { id: 'kodachrome', label: '코다크롬', hint: '빈티지 슬라이드', prompt: 'shot on Kodachrome 64 slide film, saturated vintage reds, slightly cool shadows, 1970s documentary look' },
  { id: 'cinestill', label: '시네스틸 800T', hint: '야간 · 텅스텐', prompt: 'shot on CineStill 800T film, tungsten night color balance, halation glow around light sources, cinematic' },
];

const MOODS = [
  { id: 'none', label: '지정 안 함', prompt: '' },
  { id: 'golden', label: '골든아워', prompt: 'golden hour sunlight, long warm shadows, backlit haze' },
  { id: 'overcast', label: '흐린 날', prompt: 'soft overcast diffused light, low contrast, calm mood' },
  { id: 'night', label: '밤거리', prompt: 'night scene lit by neon signs and street lamps, wet asphalt reflections' },
  { id: 'window', label: '창가 자연광', prompt: 'soft natural window light, gentle falloff into shadow, quiet interior' },
  { id: 'rain', label: '비 오는 날', prompt: 'rainy day, raindrops on glass, damp streets, moody atmosphere' },
];

const RATIOS = [
  { id: 'landscape_4_3', label: '가로 4:3' },
  { id: 'landscape_16_9', label: '가로 16:9' },
  { id: 'square_hd', label: '정사각 1:1' },
  { id: 'portrait_4_3', label: '세로 3:4' },
  { id: 'portrait_16_9', label: '세로 9:16' },
];

// 어떤 조합이든 항상 붙는 라이카 룩의 공통 뼈대
const BASE_PROMPT = [
  'candid documentary photograph',
  'natural available light',
  'creamy organic bokeh with smooth background separation',
  'tack sharp subject with three dimensional pop',
  'fine analog film grain',
  'true to life colors, no HDR, no oversaturation',
  'photorealistic, professional 35mm photography',
].join(', ');

// ── 헬퍼 ─────────────────────────────────────────────────────────

const MAX_SUBJECT = 500;

function findPreset(list, id, fallbackFirst) {
  return list.find((p) => p.id === id) || (fallbackFirst ? list[0] : null);
}

// 사용자가 쓴 장면 설명 + 선택한 프리셋들을 하나의 영문 프롬프트로 조립한다.
function buildPrompt({ subject, lens, look, mood }) {
  const parts = [
    subject,
    findPreset(LENSES, lens, true).prompt,
    findPreset(LOOKS, look, true).prompt,
    findPreset(MOODS, mood, true).prompt,
    BASE_PROMPT,
  ];
  return parts.filter(Boolean).join(', ');
}

function validateGenerateBody(body) {
  const subject = typeof body?.subject === 'string' ? body.subject.trim() : '';
  if (!subject) return { error: '어떤 장면을 찍을지 입력해주세요.' };
  if (subject.length > MAX_SUBJECT) {
    return { error: `장면 설명은 ${MAX_SUBJECT}자 이하로 입력해주세요.` };
  }

  const ratio = findPreset(RATIOS, body.ratio, false) ? body.ratio : RATIOS[0].id;

  let count = Number(body?.count);
  if (!Number.isInteger(count) || count < 1 || count > 4) count = 1;

  return {
    params: {
      subject,
      lens: body.lens,
      look: body.look,
      mood: body.mood,
      ratio,
      count,
    },
  };
}

async function callFal(endpoint, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Key ${FAL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      // fal 의 에러 본문을 그대로 노출하지 않고 상태 코드별 메시지로 바꾼다.
      const detail = json?.detail;
      const message =
        typeof detail === 'string' ? detail : Array.isArray(detail) ? detail[0]?.msg : null;
      const err = new Error(message || `이미지 생성에 실패했습니다. (fal ${res.status})`);
      err.status = res.status === 401 || res.status === 403 ? 502 : res.status;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// 한글이 섞여 있을 때만 번역한다. 실패하면 원문을 그대로 쓰고 생성은 계속 진행한다.
async function translateSubject(subject) {
  if (!HANGUL.test(subject)) return { text: subject, translated: false };
  try {
    const result = await callFal(
      FAL_LLM_ENDPOINT,
      { model: FAL_LLM_MODEL, system_prompt: TRANSLATE_SYSTEM_PROMPT, prompt: subject },
      FAL_LLM_TIMEOUT_MS
    );
    const output = typeof result?.output === 'string' ? result.output.trim() : '';
    if (!output) return { text: subject, translated: false };
    return { text: output, translated: true };
  } catch (err) {
    console.warn('[translate] 실패, 원문으로 진행:', err.message);
    return { text: subject, translated: false };
  }
}

// ── 미들웨어 ─────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// API 키가 없으면 어떤 API 도 의미가 없으므로 진입 시점에 한 번 막는다.
app.use('/api', (_req, res, next) => {
  if (!FAL_KEY) {
    return res
      .status(500)
      .json({ success: false, message: 'FAL_KEY 환경변수가 설정되지 않았습니다.' });
  }
  next();
});

// ── API: 프리셋 ──────────────────────────────────────────────────

app.get('/api/presets', (_req, res) => {
  const strip = (list) => list.map(({ id, label, hint }) => ({ id, label, hint }));
  res.json({
    success: true,
    data: {
      lenses: strip(LENSES),
      looks: strip(LOOKS),
      moods: strip(MOODS),
      ratios: RATIOS,
    },
  });
});

// ── API: 이미지 생성 ─────────────────────────────────────────────

app.post('/api/generate', async (req, res, next) => {
  try {
    const { params, error } = validateGenerateBody(req.body);
    if (error) return res.status(400).json({ success: false, message: error });

    const subjectEn = await translateSubject(params.subject);
    const prompt = buildPrompt({ ...params, subject: subjectEn.text });

    const result = await callFal(
      FAL_ENDPOINT,
      {
        prompt,
        image_size: params.ratio,
        num_images: params.count,
        num_inference_steps: 28,
        guidance_scale: 3.5,
        enable_safety_checker: true,
      },
      FAL_TIMEOUT_MS
    );

    const images = (result?.images || []).map((img) => ({
      url: img.url,
      width: img.width,
      height: img.height,
    }));

    if (images.length === 0) {
      return res
        .status(502)
        .json({ success: false, message: '이미지가 생성되지 않았습니다. 다시 시도해주세요.' });
    }

    res.json({
      success: true,
      data: {
        images,
        prompt,
        seed: result.seed ?? null,
        subjectEn: subjectEn.translated ? subjectEn.text : null,
      },
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      return res
        .status(504)
        .json({ success: false, message: '생성 시간이 초과되었습니다. 장 수를 줄여보세요.' });
    }
    if (err.status) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    next(err);
  }
});

// ── API: 다운로드 프록시 ─────────────────────────────────────────
// 이미지가 fal.media 라는 다른 오리진에 있어 <a download> 가 동작하지 않는다.
// 같은 오리진에서 attachment 로 흘려보내 저장되게 한다.

app.get('/api/download', async (req, res, next) => {
  try {
    let target;
    try {
      target = new URL(req.query.url || '');
    } catch {
      return res.status(400).json({ success: false, message: '잘못된 이미지 주소입니다.' });
    }
    if (target.protocol !== 'https:' || !ALLOWED_IMAGE_HOSTS.test(target.hostname)) {
      return res.status(400).json({ success: false, message: '허용되지 않은 이미지 주소입니다.' });
    }

    const upstream = await fetch(target.href);
    if (!upstream.ok) {
      return res
        .status(502)
        .json({ success: false, message: '이미지를 가져오지 못했습니다.' });
    }

    const filename = `leica-${Date.now()}.jpg`;
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    next(err);
  }
});

// 정의되지 않은 API 경로는 JSON 404 로 돌려준다 (SPA fallback 이 삼키지 않도록).
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: '존재하지 않는 API 경로입니다.' });
});

// ── SPA fallback (Express 5 문법) ────────────────────────────────

app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── 에러 핸들러 ──────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
});

// ── 시작 & export ────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
module.exports = app;
