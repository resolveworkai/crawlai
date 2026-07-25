"""Authored by: Mohit Singh

Stage B preprocessing (§B2). Deliberately light: Google's anti-aliased UI text OCRs BETTER in
grayscale than after hard binarization, so we grayscale + optionally upscale, and only fall back
to Otsu thresholding as a retry when a segment's confidence is poor. opencv-headless (no GUI
deps) is correct for a server/container.

Image arrays are typed `Any` (they're numpy arrays from cv2) — numpy's own type stubs use PEP-695
syntax that our mypy python_version=3.11 can't parse, and cv2 ships no stubs, so precise array
typing here buys nothing but friction. See pyproject.toml's [[tool.mypy.overrides]].
"""

from __future__ import annotations

from typing import Any

import cv2

MIN_WIDTH_FOR_UPSCALE = 1400
UPSCALE_FACTOR = 1.5


def load_gray(path: str) -> Any:
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise FileNotFoundError(f"OCR preprocess: cannot read image {path}")
    return img


def prepare(path: str) -> Any:
    """Default path: grayscale, upscale small images (LANCZOS) for crisper glyphs. No threshold."""
    gray = load_gray(path)
    h, w = gray.shape[:2]
    if w < MIN_WIDTH_FOR_UPSCALE:
        gray = cv2.resize(
            gray,
            (int(w * UPSCALE_FACTOR), int(h * UPSCALE_FACTOR)),
            interpolation=cv2.INTER_LANCZOS4,
        )
    return gray


def otsu(path: str) -> Any:
    """Retry path (§B2): binarize with Otsu when the grayscale pass came back low-confidence."""
    gray = prepare(path)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return binary
