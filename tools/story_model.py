from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
BOOK_LIST_PATH = ROOT / "books" / "books.json"


@dataclass(frozen=True)
class Target:
    paragraph_id: str
    paragraph_index: int
    target_index: int
    word: str
    start: int
    word_end: int
    eojeol_end: int

    @property
    def id(self) -> str:
        return f"{self.paragraph_id}-{self.target_index}"


@dataclass(frozen=True)
class Chunk:
    kind: str
    paragraph_id: str
    paragraph_index: int
    text: str
    sentence_end: bool
    paragraph_end: bool
    target: Target | None = None


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_books() -> list[dict[str, Any]]:
    metas = load_json(BOOK_LIST_PATH)
    books = []
    for meta in metas:
        detail_path = ROOT / meta["path"]
        detail = load_json(detail_path)
        books.append({**meta, "detail": detail})
    return books


def is_sentence_end(ch: str) -> bool:
    return ch in ".!?。！？"


def find_eojeol_end(text: str, from_index: int) -> int:
    for i in range(from_index, len(text)):
        if text[i].isspace():
            return i
    return len(text)


def find_sentence_end(text: str, from_index: int, limit: int) -> int:
    for i in range(from_index, limit):
        if is_sentence_end(text[i]):
            end = i + 1
            while end < limit and text[end] in "”\"’'":
                end += 1
            return end
    return -1


def analyze_targets(book: dict[str, Any]) -> dict[str, list[Target]]:
    targets_by_paragraph: dict[str, list[Target]] = {}
    for paragraph_index, paragraph in enumerate(book["paragraphs"]):
        cursor = 0
        targets: list[Target] = []
        for target_index, word in enumerate(paragraph.get("quizWords", [])):
            start = paragraph["text"].find(word, cursor)
            if start < 0:
                raise ValueError(f"{book['id']}:{paragraph['id']} is missing quiz word {word!r}")
            word_end = start + len(word)
            targets.append(
                Target(
                    paragraph_id=paragraph["id"],
                    paragraph_index=paragraph_index,
                    target_index=target_index,
                    word=word,
                    start=start,
                    word_end=word_end,
                    eojeol_end=find_eojeol_end(paragraph["text"], word_end),
                )
            )
            cursor = word_end
        targets_by_paragraph[paragraph["id"]] = targets
    return targets_by_paragraph


def push_narration_chunks(
    chunks: list[Chunk],
    paragraph: dict[str, Any],
    paragraph_index: int,
    start: int,
    end: int,
    paragraph_end_default: bool,
) -> None:
    cursor = start
    while cursor < end:
        sentence_end = find_sentence_end(paragraph["text"], cursor, end)
        next_end = sentence_end if sentence_end > -1 else end
        text = paragraph["text"][cursor:next_end].strip()
        if text:
            chunks.append(
                Chunk(
                    kind="narration",
                    paragraph_id=paragraph["id"],
                    paragraph_index=paragraph_index,
                    text=text,
                    sentence_end=sentence_end > -1,
                    paragraph_end=next_end >= len(paragraph["text"]) and paragraph_end_default,
                )
            )
        cursor = next_end


def push_complete_sentence_chunks_before_target(
    chunks: list[Chunk],
    paragraph: dict[str, Any],
    paragraph_index: int,
    start: int,
    target_start: int,
) -> int:
    cursor = start
    while cursor < target_start:
        sentence_end = find_sentence_end(paragraph["text"], cursor, target_start)
        if sentence_end < 0:
            break
        text = paragraph["text"][cursor:sentence_end].strip()
        if text:
            chunks.append(
                Chunk(
                    kind="narration",
                    paragraph_id=paragraph["id"],
                    paragraph_index=paragraph_index,
                    text=text,
                    sentence_end=True,
                    paragraph_end=False,
                )
            )
        cursor = sentence_end
    return cursor


def build_chunks(book: dict[str, Any], targets_by_paragraph: dict[str, list[Target]]) -> list[Chunk]:
    chunks: list[Chunk] = []
    for paragraph_index, paragraph in enumerate(book["paragraphs"]):
        cursor = 0
        for target in targets_by_paragraph.get(paragraph["id"], []):
            cursor = push_complete_sentence_chunks_before_target(
                chunks,
                paragraph,
                paragraph_index,
                cursor,
                target.start,
            )
            text = paragraph["text"][cursor:target.eojeol_end].strip()
            if text:
                chunks.append(
                    Chunk(
                        kind="target",
                        paragraph_id=paragraph["id"],
                        paragraph_index=paragraph_index,
                        text=text,
                        sentence_end=target.eojeol_end > 0 and is_sentence_end(paragraph["text"][target.eojeol_end - 1]),
                        paragraph_end=target.eojeol_end >= len(paragraph["text"]),
                        target=target,
                    )
                )
            cursor = target.eojeol_end
        push_narration_chunks(chunks, paragraph, paragraph_index, cursor, len(paragraph["text"]), True)
        if chunks and chunks[-1].paragraph_id == paragraph["id"]:
            last = chunks[-1]
            chunks[-1] = Chunk(
                kind=last.kind,
                paragraph_id=last.paragraph_id,
                paragraph_index=last.paragraph_index,
                text=last.text,
                sentence_end=last.sentence_end,
                paragraph_end=True,
                target=last.target,
            )
    return chunks


def expected_texts(book: dict[str, Any]) -> list[str]:
    targets = analyze_targets(book)
    chunks = build_chunks(book, targets)
    texts = [chunk.text for chunk in chunks]
    texts.extend(book.get("targetWords", []))
    texts.append("끝까지 읽었어요. 참 잘했어요!")
    return list(dict.fromkeys(texts))
