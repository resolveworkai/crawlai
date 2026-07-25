"""Authored by: Mohit Singh

Crawl-OCR module — Google Maps panel screenshot capture (Stage A, Playwright) + Tesseract OCR
and field parsing (Stage B), run in-process by the same worker daemon. See the module README
and md/plans (the OCR add-on spec). Wired into main.py via a parallel job-claim + LISTEN on the
`ocr_crawl_jobs` channel; the Node API owns creation, this owns execution.
"""
