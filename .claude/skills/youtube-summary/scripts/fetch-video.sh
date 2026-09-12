#!/usr/bin/env bash
# 유튜브 영상 + 자동 자막을 내려받아 지정 폴더에 저장하고, 결과 파일 경로를 출력한다.
#
# 사용법: fetch-video.sh <URL> <저장폴더> [자막언어...]
#   예:   fetch-video.sh "https://youtu.be/xxxx" week-4/class
#         fetch-video.sh "https://youtu.be/xxxx" week-4/class ko-orig en ja
#   기본 자막 언어: ko-orig(원본 음성인식) + en(영어 번역)
#
# 옵션 환경변수:
#   MAX_HEIGHT=720   해상도 상한 (기본 1080)
#   SKIP_VIDEO=1     자막만 받고 영상은 건너뛴다
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "사용법: $(basename "$0") <URL> <저장폴더> [자막언어...]" >&2
  exit 1
fi

url="$1"; shift
outdir="$1"; shift
langs="${*:-ko-orig en}"
sublangs=$(echo "$langs" | tr ' ' ',')
max_height="${MAX_HEIGHT:-1080}"

# --- yt-dlp / ffmpeg 경로 확보 -------------------------------------------
# winget 설치본은 패키지 폴더를 "사용자 PATH"에 직접 추가한다.
# 설치 직후의 셸에는 반영되지 않으므로 여기서 직접 붙여준다.
wingetpkg="$LOCALAPPDATA/Microsoft/WinGet/Packages"
if [[ -d "$wingetpkg" ]]; then
  for d in "$wingetpkg"/yt-dlp.yt-dlp_*/ "$wingetpkg"/yt-dlp.FFmpeg_*/ffmpeg-*/bin/; do
    [[ -d "$d" ]] && PATH="$d:$PATH"
  done
  export PATH
fi

command -v yt-dlp >/dev/null 2>&1 || {
  echo "오류: yt-dlp 를 찾을 수 없습니다." >&2
  echo "설치: winget install --id yt-dlp.yt-dlp --accept-package-agreements --accept-source-agreements" >&2
  exit 1
}

mkdir -p "$outdir"

echo "▶ yt-dlp $(yt-dlp --version) / 저장 위치: $outdir"
echo "▶ 자막 언어: $sublangs"
echo

# --- 제작자 자막 유무 확인 ------------------------------------------------
# "has no subtitles" 가 나오면 자동 생성 자막만 존재한다는 뜻 -> 정확도 주의 필요.
if yt-dlp --list-subs --no-playlist "$url" 2>&1 | grep -q "has no subtitles"; then
  echo "⚠ 제작자 제공 자막 없음 -> 자동 생성 자막(기계 음성인식)만 사용 가능"
  echo "  고유명사·숫자 오인식을 반드시 교정 표로 남길 것"
else
  echo "✓ 제작자 제공 자막 있음 (자동 자막보다 정확)"
fi
echo

# --- 다운로드 -------------------------------------------------------------
# --sleep-subtitles 3 : 여러 언어를 연속 요청하면 HTTP 429 가 난다. 반드시 유지.
# --convert-subs srt  : vtt 보다 다루기 쉽고 재생기 호환성이 좋다.
args=(
  --no-playlist
  --write-subs --write-auto-subs
  --sub-langs "$sublangs"
  --convert-subs srt
  --sleep-subtitles 3
  --newline
  -o "$outdir/%(title)s [%(id)s].%(ext)s"
)

if [[ "${SKIP_VIDEO:-}" == "1" ]]; then
  args+=(--skip-download)
else
  args+=(-f "bv*[height<=$max_height]+ba/b[height<=$max_height]" --merge-output-format mp4)
fi

yt-dlp "${args[@]}" "$url"

# --- 결과 보고 ------------------------------------------------------------
vid=$(yt-dlp --no-playlist --print "%(id)s" --skip-download "$url" 2>/dev/null | head -1)
echo
echo "=== 저장된 파일 ==="
ls -la "$outdir" | grep -F "$vid" || echo "(파일을 찾지 못했습니다)"
echo
echo "다음 단계: 자막 중복 제거"
echo "  bash \"$(dirname "$0")/clean-subs.sh\" \"$outdir\"/*\"[$vid].ko-orig.srt\""
