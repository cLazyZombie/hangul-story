# 한글 이야기책

만 4세 아이에게 그림 동화책을 읽어 주며 이야기 속 동물 이름을 맞히는 정적 웹 앱입니다.

첫 책은 **브레멘 음악대**입니다. 낭독은 Edge TTS로 미리 생성한 한국어 MP3를 사용하고, 단어 빈칸은 드래그 앤 드롭으로 맞춥니다.

## 로컬 실행

```bash
python3 -m http.server 8000
```

브라우저에서 `http://localhost:8000`을 엽니다.

## 음성 다시 만들기

```bash
python3 -m pip install edge-tts
python3 tools/generate_story_audio.py --force
```

## 점검

```bash
python3 -m json.tool books/books.json >/dev/null
python3 -m json.tool books/bremen.json >/dev/null
python3 tools/validate_story_data.py
node --check js/app.js
git diff --check
```

## 이미지 출처

책 배경과 삽화는 OpenAI 이미지 생성으로 만든 AI 생성 이미지입니다.
