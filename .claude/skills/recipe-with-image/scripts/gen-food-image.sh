#!/usr/bin/env bash
# Nano Banana(Gemini image model)로 음식 사진을 생성해서 파일로 저장한다.
#
# 사용법:
#   bash gen-food-image.sh "<영어 프롬프트>" <출력경로.jpg> [가로세로비]
# 예시:
#   bash gen-food-image.sh "A food photo of ..." "week-1/quest/receipe/제육볶음.jpg" 4:3
#
# API 키는 다음 순서로 찾는다:
#   1) 환경변수 GEMINI_API_KEY (.claude/settings.local.json 의 env 로 세션에 주입됨)
#   2) <repo>/.claude/settings.local.json 의 env.GEMINI_API_KEY 직접 읽기
# 모델은 MODEL 환경변수로 바꿀 수 있다 (기본: gemini-3-pro-image = Nano Banana Pro).

set -euo pipefail

PROMPT="${1:?프롬프트가 필요합니다}"
OUT="${2:?출력 파일 경로가 필요합니다}"
RATIO="${3:-4:3}"
MODEL="${MODEL:-gemini-3-pro-image}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

SETTINGS="$REPO_ROOT/.claude/settings.local.json"
KEY="${GEMINI_API_KEY:-}"
if [ -z "$KEY" ] && [ -f "$SETTINGS" ]; then
  # settings.local.json 의 env.GEMINI_API_KEY 를 직접 읽는다.
  # (설정을 방금 추가한 세션은 아직 환경변수가 주입되지 않았을 수 있음)
  KEY="$(tr -d '\r\n' < "$SETTINGS" \
    | grep -o '"GEMINI_API_KEY"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//')"
fi
if [ -z "$KEY" ]; then
  echo "ERROR: API 키가 없습니다. .claude/settings.local.json 의 env.GEMINI_API_KEY 를 설정하세요." >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 프롬프트를 JSON 문자열로 안전하게 이스케이프 (역슬래시 -> 큰따옴표 -> 개행 순서)
ESCAPED="$(printf '%s' "$PROMPT" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\t\r' '   ')"
printf '{"contents":[{"parts":[{"text":"%s"}]}],"generationConfig":{"responseModalities":["IMAGE"],"imageConfig":{"aspectRatio":"%s"}}}' \
  "$ESCAPED" "$RATIO" > "$TMP/req.json"

CODE=$(curl -s -m 300 -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent" \
  -H "x-goog-api-key: ${KEY}" \
  -H "Content-Type: application/json" \
  -d @"$TMP/req.json" \
  -o "$TMP/resp.json" -w '%{http_code}')

if [ "$CODE" != "200" ]; then
  echo "ERROR: API 호출 실패 (HTTP $CODE)" >&2
  head -c 800 "$TMP/resp.json" >&2; echo >&2
  exit 1
fi

MIME=$(grep -o '"mimeType": "image/[^"]*"' "$TMP/resp.json" | head -1 | sed 's/.*image\///; s/"$//')
if [ -z "$MIME" ]; then
  echo "ERROR: 응답에 이미지가 없습니다 (안전 필터 차단이거나 모델명 오류일 수 있음)." >&2
  head -c 800 "$TMP/resp.json" >&2; echo >&2
  exit 1
fi

# inlineData.data 중 가장 긴 값이 이미지 본문 (thoughtSignature 등과 구분)
mkdir -p "$(dirname "$OUT")"
grep -o '"data": "[^"]*"' "$TMP/resp.json" \
  | sed 's/^"data": "//; s/"$//' \
  | awk '{ if (length($0) > length(longest)) longest = $0 } END { print longest }' \
  | base64 -d > "$OUT"

SIZE=$(wc -c < "$OUT")
if [ "$SIZE" -lt 10000 ]; then
  echo "ERROR: 디코딩된 이미지가 너무 작습니다 ($SIZE bytes)." >&2
  exit 1
fi

echo "OK  model=$MODEL  mime=image/$MIME  ratio=$RATIO  bytes=$SIZE  ->  $OUT"
