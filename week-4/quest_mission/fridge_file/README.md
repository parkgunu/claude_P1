# 냉장고 (fridge)

재료 한 개당 JSON 파일 한 개로 냉장고 재고를 관리하고, 그 재고로 만들 수 있는 레시피를 받는 폴더.

```
fridge/
├── ingredients/        재료 1개 = 파일 1개 (egg.json, kimchi.json, ...)
└── recipes/            스킬이 저장한 레시피 마크다운
```

## 쓰는 법

Claude Code에서 `/recipe` 를 치면 `fridge-recipe` 스킬이 실행된다.

```
/recipe              # 재고를 훑고 요리 후보 3개를 추천받는다
/recipe 김치찌개      # 그 요리의 레시피를 바로 만든다
/recipe 15분 안에     # 조건에 맞는 후보를 추천받는다
```

결과는 `recipes/<요리이름>.md` 로 저장된다.

재고만 확인하려면:

```bash
node ../../../.claude/skills/fridge-recipe/scripts/scan-fridge.mjs ingredients
```

## 재료 파일 스키마

```json
{
  "id": "egg",
  "name": "달걀",
  "category": "단백질",
  "quantity": 8,
  "unit": "개",
  "storage": "냉장",
  "purchasedOn": "2026-09-08",
  "expiresOn": "2026-10-02",
  "tags": ["주재료", "만능"],
  "note": "특란. 프라이·찜·부침 다 가능"
}
```

| 필드 | 필수 | 설명 |
| --- | --- | --- |
| `id` | | 파일명과 동일하게. 영문 소문자 + 하이픈 |
| `name` | ✅ | 한글 재료명 |
| `category` | | `단백질` `채소` `채소/절임` `유제품` `가공육` `곡물` `양념` `기타` |
| `quantity` | ✅ | 숫자 |
| `unit` | ✅ | `개` `g` `ml` `모` `대` `장` 등 |
| `storage` | | `냉장` `냉동` `실온` |
| `purchasedOn` | | `YYYY-MM-DD` |
| `expiresOn` | ✅ | `YYYY-MM-DD` — 추천 우선순위의 기준 |
| `tags` | | `주재료` `부재료` `양념` `만능` `급함` 등 자유 |
| `note` | | 개봉 여부, 손질 상태 같은 메모 |

재료를 추가하려면 파일을 하나 더 만들고, 다 쓴 재료는 파일을 지운다.
