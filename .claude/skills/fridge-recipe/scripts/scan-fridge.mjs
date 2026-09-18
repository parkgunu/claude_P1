#!/usr/bin/env node
/**
 * 냉장고 재료 JSON 폴더를 읽어 유통기한 순으로 정리해 출력한다.
 *
 *   node scan-fridge.mjs [재료폴더] [--json] [--today=YYYY-MM-DD]
 *
 * 기본 폴더: week-4/quest/fridge/ingredients
 * 기본 출력: 사람이 읽는 마크다운 표 (--json 이면 원본 배열)
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const todayArg = args.find((a) => a.startsWith("--today="));
const dir = resolve(args.find((a) => !a.startsWith("--")) ?? "week-4/quest/fridge/ingredients");

if (!existsSync(dir)) {
  console.error(`재료 폴더가 없습니다: ${dir}`);
  process.exit(1);
}

const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** "2026-09-16" 을 로컬 자정으로 읽는다. new Date(문자열) 은 UTC 로 잡혀 하루씩 밀린다. */
const parseLocal = (v) => {
  const [y, m, d] = String(v).split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
};

const today = todayArg ? parseLocal(todayArg.slice("--today=".length)) : new Date();
today.setHours(0, 0, 0, 0);
const DAY = 86400000;

const REQUIRED = ["name", "quantity", "unit", "expiresOn"];
const items = [];
const problems = [];

for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const path = join(dir, file);
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    problems.push(`${file}: JSON 파싱 실패 — ${err.message}`);
    continue;
  }
  const missing = REQUIRED.filter((k) => doc[k] === undefined || doc[k] === "");
  if (missing.length) problems.push(`${file}: 필수 필드 누락 — ${missing.join(", ")}`);

  const expires = parseLocal(doc.expiresOn);
  const daysLeft = Number.isNaN(expires.getTime())
    ? null
    : Math.round((expires.getTime() - today.getTime()) / DAY);

  items.push({
    ...doc,
    id: doc.id ?? file.replace(/\.json$/, ""),
    category: doc.category ?? "기타",
    storage: doc.storage ?? "냉장",
    tags: doc.tags ?? [],
    daysLeft,
    status: daysLeft === null ? "unknown" : daysLeft < 0 ? "expired" : daysLeft <= 3 ? "urgent" : daysLeft <= 7 ? "soon" : "ok",
  });
}

items.sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));

if (flags.has("--json")) {
  console.log(JSON.stringify({ dir, today: ymd(today), items, problems }, null, 2));
  process.exit(0);
}

const MARK = { expired: "❌ 기한초과", urgent: "🔴 급함", soon: "🟡 곧", ok: "🟢 여유", unknown: "⚪ 미상" };
const dday = (d) => (d === null ? "-" : d < 0 ? `D+${-d}` : `D-${d}`);
const or = (v, fallback = "?") => (v === undefined || v === "" ? fallback : v);

console.log(`# 냉장고 재고 (${items.length}종) — 기준일 ${ymd(today)}`);
console.log(`폴더: ${dir}\n`);
console.log("| 상태 | 재료 | 수량 | 분류 | 보관 | 유통기한 | 남음 | 메모 |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const i of items) {
  console.log(
    `| ${MARK[i.status]} | ${or(i.name)} | ${or(i.quantity)}${or(i.unit, "")} | ${i.category} | ${i.storage} | ${or(i.expiresOn)} | ${dday(i.daysLeft)} | ${i.note || ""} |`
  );
}

const pick = (s) => items.filter((i) => i.status === s).map((i) => i.name);
console.log("");
if (pick("expired").length) console.log(`기한 지남(버릴 것): ${pick("expired").join(", ")}`);
console.log(`먼저 써야 할 재료: ${[...pick("urgent"), ...pick("soon")].join(", ") || "없음"}`);
console.log(`양념: ${items.filter((i) => i.category === "양념").map((i) => i.name).join(", ") || "없음"}`);

if (problems.length) {
  console.log("\n## 파일 문제");
  for (const p of problems) console.log(`- ${p}`);
}
