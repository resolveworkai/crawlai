"""Authored by: Mohit Singh

Stage B OCR (§B3). Runs Tesseract over each captured segment, reassembles tokens into lines
with per-line confidence, then merges a business's ordered segments while dropping the ~20%
overlap (the leading lines of segment n+1 that already ended segment n). Output: one clean line
list + a mean-confidence + the merged raw_text per business.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import pytesseract
from rapidfuzz import fuzz

from business_scout_worker.ocr import preprocess

# Tesseract links OpenMP and by default spawns a thread per core. On images this size the thread
# coordination overhead DOMINATES the actual recognition: measured on a real captured panel
# (816x1840) inside this container, the same call took 16.1s multi-threaded vs 2.90s with
# OMP_THREAD_LIMIT=1 — a 5.5x speedup for byte-identical output (84 words both ways). This was
# the single largest cost in the whole pipeline. Set before pytesseract spawns the binary.
# Single-threaded per call also makes it safe/efficient to run several OCR calls concurrently
# across worker threads instead (see pipeline.py), which is the better use of the cores.
os.environ.setdefault("OMP_THREAD_LIMIT", "1")

TESS_CONFIG = "--oem 1 --psm 6"
LOW_CONF_RETRY_THRESHOLD = 60.0
OVERLAP_MATCH_RATIO = 90.0


@dataclass
class OcrLine:
    text: str
    confidence: float


@dataclass
class OcrResult:
    lines: list[OcrLine]
    raw_text: str
    mean_confidence: float


def _configure(tesseract_cmd: str | None) -> None:
    if tesseract_cmd:
        pytesseract.pytesseract.tesseract_cmd = tesseract_cmd


def _image_to_lines(image: object, langs: str) -> list[OcrLine]:
    data = pytesseract.image_to_data(
        image, lang=langs, config=TESS_CONFIG, output_type=pytesseract.Output.DICT
    )
    # Group tokens by (block, par, line); reassemble text + average confidence per line.
    lines: dict[tuple[int, int, int], list[tuple[str, float]]] = {}
    n = len(data["text"])
    for i in range(n):
        text = str(data["text"][i]).strip()
        if not text:
            continue
        conf = float(data["conf"][i])
        if conf < 0:
            continue
        key = (int(data["block_num"][i]), int(data["par_num"][i]), int(data["line_num"][i]))
        lines.setdefault(key, []).append((text, conf))

    out: list[OcrLine] = []
    for key in sorted(lines.keys()):
        tokens = lines[key]
        line_text = " ".join(t for t, _ in tokens).strip()
        if not line_text:
            continue
        mean_conf = sum(c for _, c in tokens) / len(tokens)
        out.append(OcrLine(text=line_text, confidence=mean_conf))
    return out


def ocr_segment(image_path: str, langs: str, tesseract_cmd: str | None = None) -> list[OcrLine]:
    """OCR one segment. Grayscale pass first; if it comes back low-confidence, retry with Otsu
    binarization (§B2 fallback)."""
    _configure(tesseract_cmd)
    lines = _image_to_lines(preprocess.prepare(image_path), langs)
    if lines:
        mean = sum(line.confidence for line in lines) / len(lines)
        if mean < LOW_CONF_RETRY_THRESHOLD:
            retry = _image_to_lines(preprocess.otsu(image_path), langs)
            retry_mean = sum(line.confidence for line in retry) / len(retry) if retry else 0.0
            if retry_mean > mean:
                return retry
    return lines


def _is_overlap(prev_tail: list[OcrLine], candidate: OcrLine) -> bool:
    """True if `candidate` (a leading line of the next segment) already appeared at the tail of
    the previous segment — exact or >=90% fuzzy match, to drop the deliberate 20% overlap."""
    for line in prev_tail:
        if line.text == candidate.text:
            return True
        if fuzz.ratio(line.text, candidate.text) >= OVERLAP_MATCH_RATIO:
            return True
    return False


def merge_segments(
    segment_paths: list[str], job_dir: Path, langs: str, tesseract_cmd: str | None = None
) -> OcrResult:
    """OCR each segment in order and stitch them, dropping overlap-duplicated leading lines.
    `segment_paths` are relative (from the manifest); resolved under `job_dir`."""
    merged: list[OcrLine] = []
    for rel in segment_paths:
        seg_lines = ocr_segment(str(job_dir / rel), langs, tesseract_cmd)
        if not merged:
            merged.extend(seg_lines)
            continue
        tail = merged[-6:]
        # Skip leading lines of this segment that duplicate the previous segment's tail.
        start = 0
        for line in seg_lines:
            if _is_overlap(tail, line):
                start += 1
            else:
                break
        merged.extend(seg_lines[start:])

    raw_text = "\n".join(line.text for line in merged)
    mean_conf = sum(line.confidence for line in merged) / len(merged) if merged else 0.0
    return OcrResult(lines=merged, raw_text=raw_text, mean_confidence=mean_conf)
