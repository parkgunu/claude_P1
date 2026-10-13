// fal.ai Seedream 5.0 으로 상품 이미지를 생성해 images/ 에 저장한다.
// 사용: node gen-images.mjs            (없는 이미지만 생성)
//       node gen-images.mjs sofa-01    (특정 id만 다시 생성)
// API 키는 같은 폴더의 .env (FAL_KEY=...) 에서 읽는다. .env 는 gitignore 대상.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
const KEY = env.match(/^FAL_KEY=(.+)$/m)?.[1].trim();
if (!KEY) throw new Error('.env 에 FAL_KEY 가 없습니다');

const MODEL = 'fal-ai/bytedance/seedream/v5/lite/text-to-image';
const STYLE = 'minimal Scandinavian product photography, soft natural daylight, warm off-white seamless studio background, subtle floor shadow, centered, high detail, editorial catalog style, no text, no logo';

const ITEMS = [
  ['hero', 'a serene minimal living room with a low oatmeal boucle sofa, oak coffee table, linen curtains, large window light, wide interior shot'],
  ['sofa-01', 'a low three-seat sofa in oatmeal boucle fabric with rounded arms'],
  ['sofa-02', 'a compact two-seat sofa in sage green linen with slim walnut legs'],
  ['chair-01', 'a sculptural lounge chair in cognac leather with a curved oak frame'],
  ['chair-02', 'a minimal dining chair in light ash wood with a woven paper cord seat'],
  ['table-01', 'a round solid white oak dining table with a single pedestal base'],
  ['table-02', 'a low rectangular travertine coffee table with rounded edges'],
  ['storage-01', 'a long low walnut sideboard with fluted sliding doors'],
  ['storage-02', 'a slim white oak bookshelf with five open shelves and a few ceramic objects'],
  ['bed-01', 'a low platform bed with an upholstered headboard in warm grey fabric and linen bedding'],
  ['lamp-01', 'a paper globe floor lamp on a slim black metal stand, softly glowing'],
  ['lamp-02', 'a mushroom shaped table lamp in matte cream ceramic'],
  ['coaster-01', 'a single round solid oak wooden coaster, simple and minimal, close-up'],
  ['stool-01', 'a solid oak three-legged stool with a round seat'],
];

const headers = { Authorization: `Key ${KEY}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generate(id, subject) {
  const body = {
    prompt: `${subject}. ${STYLE}`,
    image_size: id === 'hero' ? 'landscape_16_9' : 'portrait_4_3',
    num_images: 1,
  };
  const sub = await fetch(`https://queue.fal.run/${MODEL}`, { method: 'POST', headers, body: JSON.stringify(body) }).then((r) => r.json());
  if (!sub.request_id) throw new Error(`${id}: 제출 실패 ${JSON.stringify(sub)}`);

  for (;;) {
    await sleep(2000);
    const st = await fetch(sub.status_url, { headers }).then((r) => r.json());
    if (st.status === 'COMPLETED') break;
    if (st.status !== 'IN_QUEUE' && st.status !== 'IN_PROGRESS') throw new Error(`${id}: ${JSON.stringify(st)}`);
  }
  const res = await fetch(sub.response_url, { headers }).then((r) => r.json());
  const url = res.images?.[0]?.url;
  if (!url) throw new Error(`${id}: 결과 없음 ${JSON.stringify(res)}`);

  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const ext = url.split('?')[0].split('.').pop().toLowerCase();
  const file = path.join(dir, 'images', `${id}.${['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? ext : 'png'}`);
  fs.writeFileSync(file, buf);
  console.log(`✓ ${id} → ${path.basename(file)} (${Math.round(buf.length / 1024)}KB)`);
}

const only = process.argv.slice(2);
fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
const existing = fs.readdirSync(path.join(dir, 'images')).map((f) => f.replace(/\.\w+$/, ''));
const todo = ITEMS.filter(([id]) => (only.length ? only.includes(id) : !existing.includes(id)));

// 3개씩 병렬 생성
for (let i = 0; i < todo.length; i += 3) {
  await Promise.all(todo.slice(i, i + 3).map(([id, s]) => generate(id, s).catch((e) => console.error('✗', e.message))));
}
