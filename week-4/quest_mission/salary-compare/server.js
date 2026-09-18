require('dotenv').config();

const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
// 3000(coin invest·memo 등), 3005(about-me)와 겹치지 않도록 전용 포트 사용
const PORT = process.env.PORT || 3006;

// ── 설정 (마스터 데이터) ─────────────────────────────────────────

// 직군 — 클라이언트 선택지이자 서버 검증 기준
const JOB_GROUPS = [
  '개발', '데이터·AI', '디자인', '기획·PM', '마케팅·광고', '영업·고객관리',
  '경영·인사·재무', '금융', '연구·R&D', '생산·제조', '의료·보건', '교육',
  '공공·공무원', '서비스·유통', '프리랜서·자영업', '기타',
];

// 연차 구간 (years 는 만 연차, 0 = 1년 미만)
const CAREER_BANDS = [
  { key: '0', label: '신입 (1년 미만)', min: 0, max: 0 },
  { key: '1-3', label: '1~3년차', min: 1, max: 3 },
  { key: '4-6', label: '4~6년차', min: 4, max: 6 },
  { key: '7-9', label: '7~9년차', min: 7, max: 9 },
  { key: '10-14', label: '10~14년차', min: 10, max: 14 },
  { key: '15+', label: '15년차 이상', min: 15, max: 99 },
];

// 지출 카테고리 — key 는 DB 컬럼명(exp_<key>)으로도 쓰이므로 [a-z_] 만 사용
const CATEGORIES = [
  { key: 'housing', label: '주거비', hint: '월세·관리비·공과금' },
  { key: 'food', label: '식비', hint: '장보기·외식·배달·카페' },
  { key: 'transport', label: '교통비', hint: '대중교통·유류비·차량유지' },
  { key: 'telecom', label: '통신비', hint: '휴대폰·인터넷' },
  { key: 'subscription', label: '구독료', hint: 'OTT·음악·멤버십·앱' },
  { key: 'insurance', label: '보험료', hint: '실손·종신·자동차보험' },
  { key: 'medical', label: '의료·건강', hint: '병원·약·운동' },
  { key: 'shopping', label: '쇼핑·의류', hint: '옷·생활용품·미용' },
  { key: 'leisure', label: '문화·여가', hint: '여행·취미·모임' },
  { key: 'education', label: '교육·자기계발', hint: '강의·도서·학원' },
  { key: 'family', label: '경조사·용돈', hint: '부모님 용돈·축의금' },
  { key: 'loan', label: '대출상환', hint: '원리금·카드할부' },
  { key: 'savings', label: '저축·적금', hint: '적금·청약·투자' },
  { key: 'etc', label: '기타', hint: '그 밖의 지출' },
];

const MIN_SALARY = 100_000; // 월 10만원
const MAX_AMOUNT = 100_000_000; // 항목당 월 1억원
const MAX_YEARS = 50;
const BUCKET_SIZE = 500_000; // 분포 구간 폭: 50만원
const BUCKET_COUNT = 20; // 0 ~ 1,000만원 + "1,000만원 이상" 1칸
const MIN_SAMPLE = 3; // 이보다 적으면 비교 결과를 "표본 부족"으로 표시

const EXP_COLUMNS = CATEGORIES.map((c) => `exp_${c.key}`);
const BAND_BY_KEY = new Map(CAREER_BANDS.map((b) => [b.key, b]));

// 연차 → 구간 key SQL (상수에서만 생성하므로 인젝션 여지 없음)
const BAND_SQL = `CASE ${CAREER_BANDS.map(
  (b) => `WHEN years BETWEEN ${b.min} AND ${b.max} THEN '${b.key}'`
).join(' ')} END`;

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
// 익명 저장: IP·쿠키·기기정보 등 개인을 식별할 수 있는 값은 저장하지 않는다.
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS salary_reports (
      id             BIGSERIAL PRIMARY KEY,
      job_group      TEXT    NOT NULL,
      years          INTEGER NOT NULL CHECK (years BETWEEN 0 AND ${MAX_YEARS}),
      monthly_salary INTEGER NOT NULL CHECK (monthly_salary BETWEEN ${MIN_SALARY} AND ${MAX_AMOUNT}),
      ${EXP_COLUMNS.map((c) => `${c} INTEGER NOT NULL DEFAULT 0 CHECK (${c} BETWEEN 0 AND ${MAX_AMOUNT})`).join(',\n      ')},
      total_expense  BIGINT GENERATED ALWAYS AS (${EXP_COLUMNS.map((c) => `${c}::bigint`).join(' + ')}) STORED,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS salary_reports_job_years_idx ON salary_reports (job_group, years)`);
  dbInitialized = true;
}

// ── 유틸 ─────────────────────────────────────────────────────────

const toNum = (v) => (v === null || v === undefined ? null : Number(v));
const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

const isAmount = (v, min = 0) => Number.isInteger(v) && v >= min && v <= MAX_AMOUNT;

// 요청 body 검증 → { error } 또는 정규화된 리포트
function parseReport(body) {
  const { jobGroup, years, monthlySalary, expenses } = body || {};
  if (!JOB_GROUPS.includes(jobGroup)) return { error: '직군을 선택해 주세요.' };
  if (!Number.isInteger(years) || years < 0 || years > MAX_YEARS) {
    return { error: `연차는 0~${MAX_YEARS} 사이의 정수로 입력해 주세요.` };
  }
  if (!isAmount(monthlySalary, MIN_SALARY)) {
    return { error: '월급(실수령액)은 10만원 이상 1억원 이하로 입력해 주세요.' };
  }
  if (expenses !== undefined && (typeof expenses !== 'object' || expenses === null || Array.isArray(expenses))) {
    return { error: '지출 항목 형식이 올바르지 않습니다.' };
  }
  const normalized = {};
  for (const { key, label } of CATEGORIES) {
    const v = expenses?.[key] ?? 0;
    if (!isAmount(v)) return { error: `${label} 금액은 0원 이상 1억원 이하의 정수로 입력해 주세요.` };
    normalized[key] = v;
  }
  const totalExpense = Object.values(normalized).reduce((a, b) => a + b, 0);
  if (totalExpense === 0) return { error: '지출 항목을 하나 이상 입력해 주세요.' };
  return { jobGroup, years, monthlySalary, expenses: normalized, totalExpense };
}

const bandOf = (years) => CAREER_BANDS.find((b) => years >= b.min && years <= b.max);

// 필터 조건 조립 → { sql, params }. startIndex 는 앞선 파라미터 개수 + 1
function buildWhere({ jobGroup, band }, startIndex = 1) {
  const clauses = [];
  const params = [];
  if (jobGroup) {
    params.push(jobGroup);
    clauses.push(`job_group = $${startIndex + params.length - 1}`);
  }
  if (band) {
    params.push(band.min, band.max);
    clauses.push(`years BETWEEN $${startIndex + params.length - 2} AND $${startIndex + params.length - 1}`);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// 상위 % — 나보다 큰 값의 수 + 1 을 표본 수로 나눈다 (동점은 같은 순위)
const topPercent = (greater, total) => (total > 0 ? Math.min(100, round1(((greater + 1) / total) * 100)) : null);

// 한 비교 범위(전체 / 같은 직군 / 같은 직군·연차)의 평균과 내 위치
async function compareInScope(report, scope, alreadySaved) {
  const savingsRate = report.expenses.savings / report.monthlySalary;
  const where = buildWhere(scope, 4);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n,
            avg(monthly_salary)::float8 AS avg_salary,
            avg(total_expense)::float8 AS avg_expense,
            avg(exp_savings::float8 / monthly_salary) AS avg_savings_rate,
            count(*) FILTER (WHERE monthly_salary > $1)::int AS salary_greater,
            count(*) FILTER (WHERE total_expense > $2)::int AS expense_greater,
            count(*) FILTER (WHERE exp_savings::float8 / monthly_salary > $3)::int AS savings_greater,
            ${EXP_COLUMNS.map((c) => `avg(${c})::float8 AS avg_${c}`).join(', ')}
       FROM salary_reports ${where.sql}`,
    [report.monthlySalary, report.totalExpense, savingsRate, ...where.params]
  );
  const r = rows[0];
  // 저장 후 비교면 내 행이 이미 n 에 포함, 저장 없이 비교면 나를 더한다
  const total = alreadySaved ? r.n : r.n + 1;
  return {
    key: scope.key,
    label: scope.label,
    count: r.n,
    enough: r.n >= MIN_SAMPLE,
    avgSalary: toNum(r.avg_salary),
    avgExpense: toNum(r.avg_expense),
    avgSavingsRate: toNum(r.avg_savings_rate),
    salaryTopPercent: topPercent(r.salary_greater, total),
    expenseTopPercent: topPercent(r.expense_greater, total),
    savingsRateTopPercent: topPercent(r.savings_greater, total),
    categoryAvg: Object.fromEntries(CATEGORIES.map((c) => [c.key, toNum(r[`avg_exp_${c.key}`])])),
  };
}

async function buildComparison(report, alreadySaved) {
  const band = bandOf(report.years);
  const scopes = [
    { key: 'all', label: '전체' },
    { key: 'job', label: report.jobGroup, jobGroup: report.jobGroup },
    { key: 'jobBand', label: `${report.jobGroup} · ${band.label}`, jobGroup: report.jobGroup, band },
  ];
  return {
    me: {
      jobGroup: report.jobGroup,
      years: report.years,
      careerBand: band.key,
      monthlySalary: report.monthlySalary,
      totalExpense: report.totalExpense,
      savingsRate: report.expenses.savings / report.monthlySalary,
      expenses: report.expenses,
    },
    minSample: MIN_SAMPLE,
    scopes: await Promise.all(scopes.map((s) => compareInScope(report, s, alreadySaved))),
  };
}

// 분포 히스토그램: 0 ~ BUCKET_COUNT 칸을 빠짐없이 채워서 반환
async function histogram(column, where) {
  const { rows } = await pool.query(
    `SELECT LEAST(${column} / ${BUCKET_SIZE}, ${BUCKET_COUNT})::int AS bucket, count(*)::int AS n
       FROM salary_reports ${where.sql}
      GROUP BY bucket`,
    where.params
  );
  const counts = new Map(rows.map((r) => [r.bucket, r.n]));
  return Array.from({ length: BUCKET_COUNT + 1 }, (_, i) => ({
    bucket: i,
    from: i * BUCKET_SIZE,
    to: i === BUCKET_COUNT ? null : (i + 1) * BUCKET_SIZE, // null = 상한 없음
    count: counts.get(i) || 0,
  }));
}

// ── 미들웨어 ─────────────────────────────────────────────────────

app.use(express.json({ limit: '10kb' }));

// .env · server.js 가 노출되지 않도록 폴더 전체가 아닌 index.html 만 서빙한다
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('[db] init failed:', err.message);
    res.status(500).json({ success: false, message: '데이터베이스 연결에 실패했습니다.' });
  }
});

// ── API: GET ─────────────────────────────────────────────────────

// 선택지 마스터 (직군 · 연차 구간 · 지출 카테고리)
app.get('/api/meta', (_req, res) => {
  res.json({
    success: true,
    data: {
      jobGroups: JOB_GROUPS,
      careerBands: CAREER_BANDS,
      categories: CATEGORIES,
      bucketSize: BUCKET_SIZE,
      bucketCount: BUCKET_COUNT,
      minSample: MIN_SAMPLE,
    },
  });
});

// 전체 통계 (?jobGroup=&careerBand= 로 필터)
app.get('/api/stats', async (req, res, next) => {
  try {
    const jobGroup = typeof req.query.jobGroup === 'string' && req.query.jobGroup ? req.query.jobGroup : null;
    const bandKey = typeof req.query.careerBand === 'string' && req.query.careerBand ? req.query.careerBand : null;
    if (jobGroup && !JOB_GROUPS.includes(jobGroup)) {
      return res.status(400).json({ success: false, message: '존재하지 않는 직군입니다.' });
    }
    const band = bandKey ? BAND_BY_KEY.get(bandKey) : null;
    if (bandKey && !band) {
      return res.status(400).json({ success: false, message: '존재하지 않는 연차 구간입니다.' });
    }

    const where = buildWhere({ jobGroup, band });
    // 직군별 집계는 연차 필터만, 연차별 집계는 직군 필터만 적용 (자기 차원은 전부 보여준다)
    const whereForJobs = buildWhere({ band });
    const whereForBands = buildWhere({ jobGroup });

    const [summary, salaryHist, expenseHist, byJob, byBand] = await Promise.all([
      pool.query(
        `SELECT count(*)::int AS n,
                avg(monthly_salary)::float8 AS avg_salary,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY monthly_salary)::float8 AS median_salary,
                avg(total_expense)::float8 AS avg_expense,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY total_expense)::float8 AS median_expense,
                avg(exp_savings::float8 / monthly_salary) AS avg_savings_rate,
                ${EXP_COLUMNS.map((c) => `avg(${c})::float8 AS avg_${c}`).join(', ')}
           FROM salary_reports ${where.sql}`,
        where.params
      ),
      histogram('monthly_salary', where),
      histogram('total_expense', where),
      pool.query(
        `SELECT job_group, count(*)::int AS n,
                avg(monthly_salary)::float8 AS avg_salary,
                avg(total_expense)::float8 AS avg_expense
           FROM salary_reports ${whereForJobs.sql}
          GROUP BY job_group
          ORDER BY avg_salary DESC`,
        whereForJobs.params
      ),
      pool.query(
        `SELECT ${BAND_SQL} AS band, count(*)::int AS n,
                avg(monthly_salary)::float8 AS avg_salary,
                avg(total_expense)::float8 AS avg_expense
           FROM salary_reports ${whereForBands.sql}
          GROUP BY band`,
        whereForBands.params
      ),
    ]);

    const s = summary.rows[0];
    const bandRows = new Map(byBand.rows.map((r) => [r.band, r]));
    res.json({
      success: true,
      data: {
        filter: { jobGroup, careerBand: band ? band.key : null },
        count: s.n,
        avgSalary: toNum(s.avg_salary),
        medianSalary: toNum(s.median_salary),
        avgExpense: toNum(s.avg_expense),
        medianExpense: toNum(s.median_expense),
        avgSavingsRate: toNum(s.avg_savings_rate),
        categoryAvg: Object.fromEntries(CATEGORIES.map((c) => [c.key, toNum(s[`avg_exp_${c.key}`])])),
        salaryHistogram: salaryHist,
        expenseHistogram: expenseHist,
        byJobGroup: byJob.rows.map((r) => ({
          jobGroup: r.job_group,
          count: r.n,
          avgSalary: toNum(r.avg_salary),
          avgExpense: toNum(r.avg_expense),
        })),
        byCareerBand: CAREER_BANDS.map((b) => {
          const r = bandRows.get(b.key);
          return {
            careerBand: b.key,
            label: b.label,
            count: r ? r.n : 0,
            avgSalary: r ? toNum(r.avg_salary) : null,
            avgExpense: r ? toNum(r.avg_expense) : null,
          };
        }),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── API: POST ────────────────────────────────────────────────────

// 익명 데이터 등록 → 저장 후 내 위치 비교 결과를 함께 반환 (행 id 는 돌려주지 않는다)
app.post('/api/reports', async (req, res, next) => {
  try {
    const report = parseReport(req.body);
    if (report.error) return res.status(400).json({ success: false, message: report.error });
    await pool.query(
      `INSERT INTO salary_reports (job_group, years, monthly_salary, ${EXP_COLUMNS.join(', ')})
       VALUES ($1, $2, $3, ${EXP_COLUMNS.map((_, i) => `$${i + 4}`).join(', ')})`,
      [report.jobGroup, report.years, report.monthlySalary, ...CATEGORIES.map((c) => report.expenses[c.key])]
    );
    res.status(201).json({ success: true, data: await buildComparison(report, true) });
  } catch (err) {
    next(err);
  }
});

// 저장 없이 비교만. 이미 등록한 값으로 다시 볼 때는 alreadySaved: true 를 보내
// 내 행이 표본 수에 두 번 세어지지 않게 한다.
app.post('/api/compare', async (req, res, next) => {
  try {
    const report = parseReport(req.body);
    if (report.error) return res.status(400).json({ success: false, message: report.error });
    res.json({ success: true, data: await buildComparison(report, req.body.alreadySaved === true) });
  } catch (err) {
    next(err);
  }
});

// ── API 404 & SPA fallback (Express 5 문법) ───────────────────────

app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: '존재하지 않는 API입니다.' });
});

app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── 에러 핸들러 ──────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: '요청 형식(JSON)이 올바르지 않습니다.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: '요청 데이터가 너무 큽니다.' });
  }
  console.error(err);
  res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app
    .listen(PORT, () => console.log(`Salary compare server running on http://localhost:${PORT}`))
    .on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`포트 ${PORT} 이(가) 이미 사용 중입니다. 다른 포트로 실행하세요: PORT=3007 npm start`);
        process.exit(1);
      }
      throw err;
    });
}
module.exports = app;
