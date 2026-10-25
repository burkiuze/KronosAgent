---
name: translation
description: Translate or localise text, documents, UI strings (JSON/YAML/PO) and markdown between languages while preserving formatting, placeholders, tone and terminology — with special care for English ↔ Turkish. Use for any translation or localisation request.
version: 1.0.0
category: writing
tags: [translation, localization, i18n, turkish, multilingual]
requires:
  toolsets: [files]
---

# Translation & localisation

## Preserve structure

- Keep markdown, HTML tags, code blocks, URLs, file paths and inline code **untouched**.
- Keep placeholders exactly: `{name}`, `{{count}}`, `%s`, `%1$d`, `:param`, `<0>…</0>`.
- For JSON/YAML/PO files translate values only, never keys; keep ordering; validate the
  file parses afterwards (`node -e "JSON.parse(require('fs').readFileSync('x.json'))"`).
- Respect plural forms of the target language (ICU `{count, plural, one {…} other {…}}`).

## Meaning over words

Translate intent and register (formal "siz" vs informal "sen" in Turkish; "Sie"/"du" in
German). Adapt idioms, units, date/number formats (`1.234,56` in tr/de), currency and examples
for the locale. Keep brand names and product terms consistent — build a glossary for longer
jobs and reuse it.

## Turkish specifics

- Dotted/dotless i: `I → ı`, `İ → i` — never lowercase with ASCII rules (use `toLocaleLowerCase('tr')`).
- Agglutinative suffixes follow vowel harmony and attach to placeholders awkwardly:
  prefer phrasings like "{name} adlı kullanıcı" over suffixing a variable.
- UI text: imperative, concise ("Kaydet", "Yeni sohbet"), sentence case.

## Quality pass

Back-translate tricky sentences mentally; check numbers, names and negations survived;
read the result aloud for fluency. Mention any ambiguous source phrases you had to interpret.
