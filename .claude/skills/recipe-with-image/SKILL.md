---
name: recipe-with-image
description: "요리 레시피를 한국어 마크다운으로 작성하고, 그 요리에 맞는 음식 사진을 Nano Banana(Gemini 이미지 모델)로 생성해 문서에 넣는다. '레시피 알려줘', '안주 추천', '○○ 만드는 법', '레시피에 이미지 넣어줘', '나노바나나로 사진 만들어줘' 같은 요청에 사용한다. 이미지 없이 텍스트 레시피만 원하는 경우에는 이미지 생성을 건너뛴다."
---

# 레시피 + 음식 사진 생성

`week-1/quest/receipe/제육볶음.md`, `차돌박이숙주볶음.md` 와 동일한 형식으로 레시피를 만들고,
같은 폴더에 같은 이름의 사진(`.jpg`)을 생성해 문서 맨 위에 넣는다.

## 절차

1. **요리 선정** — 사용자의 조건(안주/야식/손님상, 재료, 조리시간, 매운 정도)에 맞는 요리 하나를 고른다.
   - `week-1/quest/receipe/` 에 이미 있는 요리와 겹치지 않게 한다. 먼저 `ls` 로 확인할 것.
   - 이유를 한 줄로 설명한다 (예: "15분이면 끝나는 포장마차식 안주").
2. **레시피 작성** — 아래 템플릿대로 `week-1/quest/receipe/<요리이름>.md` 에 저장한다.
3. **사진 생성** — 아래 스크립트로 `week-1/quest/receipe/<요리이름>.jpg` 를 만든다.
4. **확인** — Read 툴로 생성된 이미지를 직접 보고, 요리와 다르게 나왔으면 프롬프트를 고쳐 다시 생성한다.
5. **보고** — 파일 링크와 핵심 포인트 3가지 정도를 요약해 알려준다.

## 레시피 마크다운 템플릿

```markdown
# <요리 이름> (<한 줄 부제>)

![<요리 이름>](./<요리이름>.jpg)

<이 요리가 왜 이 상황에 맞는지 1~2문장. 조리 시간 언급.>

## 재료 (2인분)

- <주재료와 정확한 g/개수>
- ...

### 양념장
- ...

## 만드는 법

1. <단계마다 불 세기와 시간을 명시. 실패 포인트는 **굵게**.>
...

## 팁

- <실패 방지 요령, 대체 재료, 매운맛 조절, 남은 재료 활용>
```

작성 규칙:
- 한국어, 존댓말 없는 담백한 설명체(`~한다`)로 쓰되 팁 섹션만 `~해요` 체를 써도 된다.
- 계량은 `큰술/작은술/g/개` 로 통일한다. "적당히"는 쓰지 않는다.
- 단계는 7~9개로. 각 단계에 **불 세기와 시간**을 반드시 넣는다.
- 이미지 경로는 `./<파일명>.jpg` 상대경로로 넣는다. 파일명에 공백을 넣지 않는다.

## 사진 생성

```bash
bash .claude/skills/recipe-with-image/scripts/gen-food-image.sh \
  "<영어 프롬프트>" "week-1/quest/receipe/<요리이름>.jpg" 4:3
```

- API 키는 `.claude/settings.local.json` 의 `env.GEMINI_API_KEY` 에 있다. 스크립트가 환경변수 → 이 파일 순으로 알아서 읽으므로 키를 명령줄이나 문서에 적지 않는다.
- 기본 모델은 `gemini-3-pro-image`(Nano Banana Pro). 더 빠르게 뽑으려면 `MODEL=gemini-3.1-flash-image` 를 앞에 붙인다.
- 성공하면 `OK model=... bytes=... -> 경로` 가 출력된다. 실패 시 HTTP 코드와 응답 앞부분을 그대로 보여주므로 그걸 보고 고친다.

### 프롬프트 작성 공식

프롬프트는 **영어로**, 아래 5요소를 순서대로 이어 붙인다:

1. **요리 정체** — 로마자 표기 + 영어 설명
   `Korean 'chadolbagi sukju bokkeum' — thinly sliced beef brisket stir-fried with mung bean sprouts`
2. **그릇과 배경** — `served sizzling in a black cast iron pan on a rustic wooden table`
3. **디테일** — 색·질감·고명·김
   `glossy caramelized beef, crisp white bean sprouts, chopped green onion, red chili slices, sesame seeds, light steam rising`
4. **곁들임** — 술안주면 `a green soju bottle and one small shot glass beside the pan`, 밥반찬이면 `a bowl of white rice and side dishes`
5. **촬영 스타일** — `45 degree angle, warm evening lighting, shallow depth of field, high-end Korean food magazine photography, no text, no watermark`

`no text, no watermark` 는 항상 넣는다. 한글이 이미지에 들어가면 깨진 글자로 나온다.

## 주의

- 모델이 돌려주는 건 **JPEG** 다. 파일 확장자를 `.jpg` 로 맞춘다.
- 이미지 1장에 30초~1분 정도 걸린다. 타임아웃은 스크립트에서 300초로 잡혀 있다.
- 사용자가 "찾아줘"라고 해도 Nano Banana는 검색이 아니라 **생성** 모델이다. 새로 만든 사진이라는 점을 알려준다.
- 같은 요리를 다시 뽑을 때는 기존 `.jpg` 를 덮어쓰기 전에 사용자에게 확인한다.
