#!/usr/bin/env python3
"""Generate Edge TTS MP3 files for Hangul Story."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from story_model import ROOT, expected_texts, load_books

try:
    import edge_tts
except ImportError as exc:
    raise SystemExit(
        "edge-tts가 필요합니다. 먼저 `python3 -m pip install edge-tts`를 실행하세요."
    ) from exc


DEFAULT_VOICE = "ko-KR-SunHiNeural"
DEFAULT_RATE = "-8%"
DEFAULT_PITCH = "+0Hz"
DEFAULT_VOLUME = "+0%"


def text_path_part(text: str) -> str:
    return "_".join(f"{ord(ch):04x}" for ch in text)


def build_items() -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    seen: set[str] = set()
    for meta in load_books():
        book = meta["detail"]
        for index, text in enumerate(expected_texts(book), start=1):
            if text in seen:
                continue
            seen.add(text)
            if text in book.get("targetWords", []):
                path = f"audio/words/{text_path_part(text)}.mp3"
            else:
                path = f"audio/story/{book['id']}-{index:03d}.mp3"
            items.append({"text": text, "path": path})
    return items


async def synthesize_item(
    item: dict[str, str],
    voice: str,
    rate: str,
    pitch: str,
    volume: str,
    force: bool,
    semaphore: asyncio.Semaphore,
) -> bool:
    output_path = ROOT / item["path"]
    if output_path.exists() and not force:
        return False

    output_path.parent.mkdir(parents=True, exist_ok=True)
    async with semaphore:
        for attempt in range(3):
            try:
                communicate = edge_tts.Communicate(
                    text=item["text"],
                    voice=voice,
                    rate=rate,
                    volume=volume,
                    pitch=pitch,
                )
                await communicate.save(str(output_path))
                print(f"{item['text']} -> {item['path']}")
                return True
            except Exception:
                if attempt == 2:
                    raise
                await asyncio.sleep(1 + attempt)
    return False


def write_audio_map(items: list[dict[str, str]]) -> None:
    map_path = ROOT / "audio" / "audio-map.json"
    audio_map = {
        item["text"]: item["path"]
        for item in items
        if (ROOT / item["path"]).exists()
    }
    map_path.parent.mkdir(parents=True, exist_ok=True)
    map_path.write_text(
        json.dumps(audio_map, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


async def generate(args: argparse.Namespace) -> None:
    items = build_items()
    semaphore = asyncio.Semaphore(args.concurrency)
    results = await asyncio.gather(*[
        synthesize_item(
            item,
            voice=args.voice,
            rate=args.rate,
            pitch=args.pitch,
            volume=args.volume,
            force=args.force,
            semaphore=semaphore,
        )
        for item in items
    ])
    write_audio_map(items)
    print(f"generated {sum(results)} files, mapped {len(items)} texts")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="이미 있는 MP3도 다시 생성")
    parser.add_argument("--voice", default=DEFAULT_VOICE, help="Edge TTS voice short name")
    parser.add_argument("--rate", default=DEFAULT_RATE, help="예: -8%%, +0%%")
    parser.add_argument("--pitch", default=DEFAULT_PITCH, help="예: +0Hz")
    parser.add_argument("--volume", default=DEFAULT_VOLUME, help="예: +0%%")
    parser.add_argument("--concurrency", type=int, default=3)
    args = parser.parse_args()
    asyncio.run(generate(args))


if __name__ == "__main__":
    main()
