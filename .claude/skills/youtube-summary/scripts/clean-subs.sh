#!/usr/bin/env bash
# YouTube 자동 자막(rolling 방식)의 중복 줄을 제거해 "시각<TAB>문장" 형태로 출력한다.
#
# 자동 자막은 한 줄씩 밀려 올라가는 구조라 같은 문장이 2~3개 블록에 반복된다.
#   1  00:00:00,280 --> 00:00:02,590   [빈줄] / "삼성전자가 애플을 겨냥한"
#   2  00:00:02,590 --> 00:00:02,600   "삼성전자가 애플을 겨냥한" / [빈줄]
#   3  00:00:02,600 --> 00:00:05,670   "삼성전자가 애플을 겨냥한" / "디스전을 이어가고"
# -> 직전에 출력한 문장과 같으면 버리고, 새 문장만 해당 블록 시작시각과 함께 남긴다.
#
# 사용법: clean-subs.sh <자막파일.srt|.vtt>
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "사용법: $(basename "$0") <자막파일.srt 또는 .vtt>" >&2
  exit 1
fi

sub="$1"
[[ -f "$sub" ]] || { echo "오류: 파일 없음 - $sub" >&2; exit 1; }

# BOM 제거 + CRLF 정규화 후 블록 단위(빈 줄 구분)로 파싱
sed -e '1s/^\xEF\xBB\xBF//' -e 's/\r$//' "$sub" | awk '
  BEGIN { RS = ""; FS = "\n" }

  {
    # 타임코드가 있는 줄을 찾는다 (srt는 2번째 줄, vtt는 위치가 다를 수 있음)
    tc = 0
    for (i = 1; i <= NF; i++) {
      if ($i ~ /-->/) { tc = i; break }
    }
    if (tc == 0) next          # WEBVTT 헤더, NOTE 블록 등은 건너뛴다

    split($tc, t, " --> ")
    start = t[1]
    gsub(/^[ \t]+|[ \t]+$/, "", start)

    # 00:01:23,456 또는 00:01:23.456 -> 1:23 (1시간 넘으면 1:01:23)
    hh = substr(start, 1, 2) + 0
    mm = substr(start, 4, 2) + 0
    ss = substr(start, 7, 2) + 0
    if (hh > 0) stamp = sprintf("%d:%02d:%02d", hh, mm, ss)
    else        stamp = sprintf("%d:%02d", mm, ss)

    # 타임코드 다음 줄부터가 본문
    for (i = tc + 1; i <= NF; i++) {
      line = $i

      # vtt 인라인 태그(<c>, <00:00:01.000> 등)와 위치 지정자 제거
      gsub(/<[^>]*>/, "", line)

      # 앞뒤 공백 + NBSP(U+00A0) 정리
      gsub(/^([ \t]|\xc2\xa0)+/, "", line)
      gsub(/([ \t]|\xc2\xa0)+$/, "", line)

      if (line == "") continue
      if (line == last) continue   # 직전 출력과 동일 -> rolling 중복

      printf "%s\t%s\n", stamp, line
      last = line
    }
  }
'
