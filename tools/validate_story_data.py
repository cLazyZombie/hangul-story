#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

from story_model import ROOT, analyze_targets, build_chunks, expected_texts, load_books


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def validate_paths(book: dict) -> None:
    require((ROOT / book["cover"]).exists(), f"missing cover: {book['cover']}")
    paragraph_images = [paragraph["image"] for paragraph in book["paragraphs"]]
    require(
        len(paragraph_images) == len(set(paragraph_images)),
        f"{book['id']} has duplicate paragraph images",
    )
    for paragraph in book["paragraphs"]:
        require((ROOT / paragraph["image"]).exists(), f"missing paragraph image: {paragraph['image']}")


def validate_targets(book: dict) -> None:
    target_words = set(book.get("targetWords", []))
    distractors = set(book.get("distractorWords", []))
    require(target_words, f"{book['id']} has no targetWords")
    require(len(target_words | distractors) >= 5, f"{book['id']} needs enough choices")

    targets_by_paragraph = analyze_targets(book)
    chunks = build_chunks(book, targets_by_paragraph)
    target_chunks = [chunk for chunk in chunks if chunk.kind == "target"]
    require(target_chunks, f"{book['id']} has no target chunks")

    for paragraph in book["paragraphs"]:
      for word in paragraph.get("quizWords", []):
          require(word in target_words, f"{book['id']} quiz word is not in targetWords: {word}")

    for chunk in target_chunks:
        require(chunk.target is not None, "target chunk missing target")
        require(chunk.target.word in chunk.text, f"target text does not include word: {chunk.text}")
        require(len([chunk.target.word, *list((target_words | distractors) - {chunk.target.word})][:5]) <= 5, "too many choices")


def validate_audio(book: dict) -> None:
    map_path = ROOT / "audio" / "audio-map.json"
    if not map_path.exists():
        return
    audio_map = json.loads(map_path.read_text(encoding="utf-8"))
    for text in expected_texts(book):
        require(text in audio_map, f"audio-map missing text: {text}")
        require((ROOT / audio_map[text]).exists(), f"audio file missing: {audio_map[text]}")


def main() -> None:
    for meta in load_books():
        book = meta["detail"]
        validate_paths(book)
        validate_targets(book)
        validate_audio(book)
    print("story data ok")


if __name__ == "__main__":
    main()
