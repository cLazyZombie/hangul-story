# 저장소 지침

## 프로젝트 구조

`hangul-story`는 만 4세 아이를 위한 정적 한글 그림 동화책 앱입니다. 백엔드와 빌드 도구 없이 GitHub Pages에서 바로 실행되는 HTML/CSS/JavaScript 구조를 유지합니다.

- `index.html`: 책장 화면과 읽기 화면의 DOM 구조
- `css/style.css`: 그림책 배경, 반응형 레이아웃, 드래그/정답/오답 상태
- `js/app.js`: 책 로딩, 낭독 진행, 빈칸/선택지, 드래그 앤 드롭, 터치 입력
- `books/books.json`: 책 목록
- `books/*.json`: 책 본문, 단락 이미지, 학습 단어 데이터
- `images/`: UI 배경과 단락 삽화
- `audio/`: Edge TTS로 생성한 정적 MP3와 `audio-map.json`
- `tools/`: 데이터 검증과 음성 생성 스크립트

## 실행과 점검

- `python3 -m http.server 8000`: 로컬 정적 서버 실행
- `python3 -m json.tool books/books.json >/dev/null`
- `python3 -m json.tool books/bremen.json >/dev/null`
- `python3 tools/validate_story_data.py`
- `python3 tools/generate_story_audio.py --force`: Edge TTS 음성 재생성
- `node --check js/app.js`
- `git diff --check`

이 앱은 JSON과 오디오 파일을 `fetch()`/`Audio`로 읽으므로 `file://`가 아니라 HTTP 서버로 확인합니다.

## 구현 규칙

한국어 낭독 품질은 제품 동작의 일부입니다. 학습 단어가 들어 있는 어절 끝까지 읽고 멈춘 뒤, 아이가 정답 단어를 빈칸에 드래그하면 다음 구간을 읽습니다.

조사가 붙은 학습 단어는 단어만 빈칸으로 가립니다. 예를 들어 `당나귀가`는 `____가`로 보입니다. 단락이 바뀌면 오른쪽 큰 삽화도 함께 바뀌어야 합니다.

커밋 메시지는 한국어로 짧고 구체적으로 작성합니다.
