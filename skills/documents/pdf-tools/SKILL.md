---
name: pdf-tools
description: Work with PDF files — extract text and tables, OCR scans, merge, split, rotate, fill forms, convert to/from images or markdown, and summarise long PDFs. Use whenever a .pdf is involved.
version: 1.0.0
category: documents
tags: [pdf, ocr, extract, merge, documents]
requires:
  toolsets: [shell, code, files]
---

# PDF tools

## Extract text

1. `python scripts/pdf_text.py file.pdf [--pages 1-5]` — tries `pdftotext -layout`
   (poppler), then `pypdf`, and reports pages with no text (likely scans).
2. Scanned pages → OCR: `ocrmypdf in.pdf out.pdf` (adds a text layer) or
   `pdftoppm -r 300 -png in.pdf page && tesseract page-1.png out -l eng+tur`.
3. Tables: `camelot`/`pdfplumber` (`page.extract_tables()`), then pandas.

For long documents, extract per page, summarise per section, then synthesise — and cite page
numbers in the summary.

## Manipulate (qpdf / pypdf)

- Merge: `qpdf --empty --pages a.pdf b.pdf -- merged.pdf`
- Split pages 3–7: `qpdf in.pdf --pages . 3-7 -- part.pdf`
- Rotate: `qpdf in.pdf out.pdf --rotate=+90:1-3`
- Decrypt (with the password the user provided): `qpdf --password=… --decrypt in.pdf out.pdf`
- Compress: `gs -sDEVICE=pdfwrite -dPDFSETTINGS=/ebook -o small.pdf in.pdf`

## Create

Markdown → PDF: `pandoc doc.md -o doc.pdf` (or HTML → PDF with the `browser` tool's print).
Forms: `pypdf` `PdfWriter.update_page_form_field_values`.

Always write to a new file; never overwrite the user's original.
