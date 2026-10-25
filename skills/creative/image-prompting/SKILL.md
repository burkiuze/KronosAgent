---
name: image-prompting
description: Write strong prompts for image generation (OpenAI, Flux/fal, Replicate, SDXL) and iterate — subject, style, composition, lighting, aspect ratio — including consistent characters, pixel art, icons, posters and product shots. Use whenever the user wants an image, illustration, avatar, logo concept or wallpaper.
version: 1.0.0
category: creative
tags: [image, art, prompt, illustration, pixel-art]
requires:
  toolsets: [image]
---

# Image prompting

## Prompt anatomy (in this order)

1. **Subject** — who/what, with 2–3 concrete distinguishing details.
2. **Action / pose / expression**.
3. **Setting** — place, time of day, weather.
4. **Style / medium** — "16-bit pixel art", "watercolour", "isometric 3D render",
   "35mm film photo", "flat vector icon", "ukiyo-e woodblock".
5. **Composition** — close-up / wide shot, angle, rule of thirds, negative space for text.
6. **Lighting & colour** — "golden hour rim light", "neon teal and magenta", limited palette.
7. **Quality cues** suited to the model (photo: lens, depth of field; illustration: line
   weight, texture).

Pick the aspect ratio for the use: 1:1 avatars/icons, 16:9 wallpapers/slides, 9:16 phone
wallpapers/stories, 3:4 posters.

## Iterate

Generate (`generate_image`), look at the result (`view_image`), then change **one** thing per
iteration and say what you changed. Keep a seed/description block to stay consistent across a
series (same character sheet text every time).

## Specific forms

- **Pixel art**: state the resolution ("32×32 sprite"), palette size, "crisp pixels, no
  anti-aliasing, transparent background".
- **Logos/icons**: generators are poor at text — ask for the mark only and set type separately.
- **Text in images**: keep it to 1–3 short words in quotes; verify spelling in the output.

Respect people's likeness and IP: no realistic images of real private individuals, no
copying a living artist's signature style on request for commercial use.

Without an image provider configured, Kronos falls back to its procedural pixel-art Kronos
portrait — suggest adding an OpenAI/fal/Replicate key in Settings → API Keys for real
generation.
