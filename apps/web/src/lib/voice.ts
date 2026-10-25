import { baseUrl, token } from './api';

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void;
  onend: () => void;
  onerror: (e: { error: string }) => void;
  start(): void;
  stop(): void;
};

export function speechRecognitionAvailable(): boolean {
  return Boolean((window as unknown as Record<string, unknown>).SpeechRecognition || (window as unknown as Record<string, unknown>).webkitSpeechRecognition);
}

/**
 * Voice input: browser speech recognition when available, otherwise record audio and
 * transcribe on the gateway (OpenAI/Groq Whisper).
 */
export class VoiceInput {
  private rec?: Recognition;
  private media?: MediaRecorder;
  private chunks: Blob[] = [];
  active = false;

  constructor(private onText: (text: string, final: boolean) => void, private onState: (active: boolean) => void, private onError: (msg: string) => void) {}

  async start(): Promise<void> {
    if (this.active) return;
    const Ctor = ((window as unknown as Record<string, unknown>).SpeechRecognition || (window as unknown as Record<string, unknown>).webkitSpeechRecognition) as (new () => Recognition) | undefined;
    if (Ctor) {
      const rec = new Ctor();
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = true;
      rec.continuous = true;
      rec.onresult = (e) => {
        let text = '';
        let final = true;
        for (let i = 0; i < e.results.length; i += 1) {
          const r = e.results[i] as ArrayLike<{ transcript: string }> & { isFinal: boolean };
          text += r[0]?.transcript ?? '';
          if (!r.isFinal) final = false;
        }
        this.onText(text, final);
      };
      rec.onend = () => this.setActive(false);
      rec.onerror = (e) => {
        this.onError(`Speech recognition: ${e.error}`);
        this.setActive(false);
      };
      this.rec = rec;
      rec.start();
      this.setActive(true);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.chunks = [];
      const media = new MediaRecorder(stream);
      media.ondataavailable = (ev) => this.chunks.push(ev.data);
      media.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(this.chunks, { type: media.mimeType || 'audio/webm' });
        try {
          const res = await fetch(`${baseUrl}/api/voice/transcribe`, { method: 'POST', headers: { 'content-type': blob.type, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: blob });
          const j = (await res.json()) as { text?: string; error?: string };
          if (!res.ok) throw new Error(j.error ?? 'transcription failed');
          this.onText(j.text ?? '', true);
        } catch (e) {
          this.onError((e as Error).message);
        }
        this.setActive(false);
      };
      this.media = media;
      media.start();
      this.setActive(true);
    } catch (e) {
      this.onError(`Microphone unavailable: ${(e as Error).message}`);
    }
  }

  stop(): void {
    this.rec?.stop();
    if (this.media?.state === 'recording') this.media.stop();
  }

  private setActive(a: boolean): void {
    this.active = a;
    this.onState(a);
  }
}

function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_#>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .slice(0, 3000);
}

let audio: HTMLAudioElement | undefined;

/** Speak a reply: server TTS when configured, otherwise the system voice. */
export async function speak(text: string, mode: 'browser' | 'server' = 'browser'): Promise<void> {
  const clean = stripMarkdown(text);
  if (!clean.trim()) return;
  if (mode === 'server') {
    try {
      const res = await fetch(`${baseUrl}/api/voice/speak`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ text: clean }) });
      if (res.ok) {
        const blob = await res.blob();
        audio?.pause();
        audio = new Audio(URL.createObjectURL(blob));
        await audio.play();
        return;
      }
    } catch {
      /* fall back to the system voice */
    }
  }
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = navigator.language || 'en-US';
  window.speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  audio?.pause();
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}
