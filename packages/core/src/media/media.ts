import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KronosConfig } from '../config/schema.js';
import { kronosPortrait } from './png.js';
import { slugify } from '../util/misc.js';

export interface GeneratedImage {
  path: string;
  mediaType: string;
  data: Buffer;
  provider: string;
  revisedPrompt?: string;
}

export function imageProviderStatus(cfg: KronosConfig['image']): { provider: string; ready: boolean; reason?: string } {
  if (cfg.provider === 'none') return { provider: 'none', ready: false, reason: 'image generation disabled' };
  if (cfg.provider === 'openai' && process.env.OPENAI_API_KEY) return { provider: 'openai', ready: true };
  if (cfg.provider === 'fal' && (process.env.FAL_KEY || process.env.FAL_API_KEY)) return { provider: 'fal', ready: true };
  if (cfg.provider === 'replicate' && process.env.REPLICATE_API_TOKEN) return { provider: 'replicate', ready: true };
  return { provider: 'procedural', ready: true, reason: `no ${cfg.provider} key — using the built-in procedural renderer` };
}

export async function generateImage(prompt: string, cfg: KronosConfig['image'], outDir: string, opts: { size?: string; filename?: string; signal?: AbortSignal } = {}): Promise<GeneratedImage> {
  mkdirSync(outDir, { recursive: true });
  const base = opts.filename ? slugify(opts.filename.replace(/\.(png|jpe?g|webp)$/i, ''), 60) : `${slugify(prompt, 40)}-${Date.now().toString(36)}`;
  const status = imageProviderStatus(cfg);
  let data: Buffer;
  let mediaType = 'image/png';
  let revisedPrompt: string | undefined;
  if (status.provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: cfg.model || 'gpt-image-1', prompt, size: opts.size ?? cfg.size, n: 1 }),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`OpenAI image generation failed (${res.status}): ${(await res.text()).slice(0, 400)}`);
    const j = (await res.json()) as { data?: { b64_json?: string; url?: string; revised_prompt?: string }[] };
    const item = j.data?.[0];
    if (item?.b64_json) data = Buffer.from(item.b64_json, 'base64');
    else if (item?.url) data = Buffer.from(await (await fetch(item.url)).arrayBuffer());
    else throw new Error('image API returned no data');
    revisedPrompt = item?.revised_prompt;
  } else if (status.provider === 'fal') {
    const res = await fetch(`https://fal.run/${cfg.model && cfg.model.includes('/') ? cfg.model : 'fal-ai/flux/schnell'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Key ${process.env.FAL_KEY || process.env.FAL_API_KEY}` },
      body: JSON.stringify({ prompt, image_size: 'square_hd' }),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`fal.ai image generation failed (${res.status}): ${(await res.text()).slice(0, 400)}`);
    const j = (await res.json()) as { images?: { url: string; content_type?: string }[] };
    const url = j.images?.[0]?.url;
    if (!url) throw new Error('fal.ai returned no image');
    data = Buffer.from(await (await fetch(url)).arrayBuffer());
    mediaType = j.images?.[0]?.content_type ?? 'image/png';
  } else if (status.provider === 'replicate') {
    const res = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`, prefer: 'wait' },
      body: JSON.stringify({ input: { prompt } }),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`Replicate failed (${res.status}): ${(await res.text()).slice(0, 400)}`);
    const j = (await res.json()) as { output?: string[] | string };
    const url = Array.isArray(j.output) ? j.output[0] : j.output;
    if (!url) throw new Error('Replicate returned no image');
    data = Buffer.from(await (await fetch(url)).arrayBuffer());
    mediaType = url.endsWith('.webp') ? 'image/webp' : 'image/png';
  } else {
    data = kronosPortrait(prompt);
  }
  const ext = mediaType === 'image/webp' ? 'webp' : mediaType === 'image/jpeg' ? 'jpg' : 'png';
  const path = join(outDir, `${base}.${ext}`);
  writeFileSync(path, data);
  return { path, mediaType, data, provider: status.provider, revisedPrompt };
}

export async function textToSpeech(text: string, cfg: KronosConfig['voice'], outDir: string, opts: { voice?: string; signal?: AbortSignal } = {}): Promise<{ path: string; mediaType: string; data: Buffer; provider: string }> {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `speech-${Date.now().toString(36)}.mp3`);
  if ((cfg.tts === 'elevenlabs' || (!process.env.OPENAI_API_KEY && process.env.ELEVENLABS_API_KEY)) && process.env.ELEVENLABS_API_KEY) {
    const voice = opts.voice && opts.voice.length > 15 ? opts.voice : '21m00Tcm4TlvDq8ikWAM';
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'xi-api-key': process.env.ELEVENLABS_API_KEY, accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`ElevenLabs TTS failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const data = Buffer.from(await res.arrayBuffer());
    writeFileSync(path, data);
    return { path, mediaType: 'audio/mpeg', data, provider: 'elevenlabs' };
  }
  if (!process.env.OPENAI_API_KEY) throw new Error('Text-to-speech needs OPENAI_API_KEY or ELEVENLABS_API_KEY (the desktop app can also speak with the system voice).');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: cfg.ttsModel || 'gpt-4o-mini-tts', voice: opts.voice || cfg.voice || 'alloy', input: text.slice(0, 4000), response_format: 'mp3' }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`OpenAI TTS failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = Buffer.from(await res.arrayBuffer());
  writeFileSync(path, data);
  return { path, mediaType: 'audio/mpeg', data, provider: 'openai' };
}

export async function transcribe(audio: Buffer, mediaType: string, cfg: KronosConfig['voice'], signal?: AbortSignal): Promise<string> {
  const useGroq = cfg.stt === 'groq' || (!process.env.OPENAI_API_KEY && process.env.GROQ_API_KEY);
  const key = useGroq ? process.env.GROQ_API_KEY : process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Speech-to-text needs OPENAI_API_KEY or GROQ_API_KEY.');
  const url = useGroq ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions';
  const ext = mediaType.includes('ogg') ? 'ogg' : mediaType.includes('webm') ? 'webm' : mediaType.includes('mp4') || mediaType.includes('m4a') ? 'm4a' : mediaType.includes('wav') ? 'wav' : 'mp3';
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mediaType }), `audio.${ext}`);
  form.append('model', useGroq ? 'whisper-large-v3-turbo' : cfg.sttModel || 'whisper-1');
  const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal });
  if (!res.ok) throw new Error(`transcription failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { text?: string };
  return (j.text ?? '').trim();
}
