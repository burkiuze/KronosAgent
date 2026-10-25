import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { sendPlatformMessage, defaultConfig } from '@kronos/core';

// a tiny in-process SMTP server that records what it receives
let server: Server;
let port = 0;
const received: { from?: string; to: string[]; data: string; auth?: string }[] = [];

beforeAll(async () => {
  server = createServer((sock) => {
    const mail = { to: [] as string[], data: '' } as (typeof received)[number];
    let inData = false;
    let buf = '';
    sock.write('220 test ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            received.push(mail);
            sock.write('250 queued\r\n');
          } else mail.data += `${line}\n`;
          continue;
        }
        if (/^EHLO/i.test(line)) sock.write('250-test\r\n250 AUTH PLAIN\r\n');
        else if (/^MAIL FROM:<(.+)>/i.test(line)) (mail.from = /<(.+)>/.exec(line)?.[1]), sock.write('250 ok\r\n');
        else if (/^RCPT TO:<(.+)>/i.test(line)) (mail.to.push(/<(.+)>/.exec(line)?.[1] ?? ''), sock.write('250 ok\r\n'));
        else if (/^DATA/i.test(line)) (inData = true), sock.write('354 go\r\n');
        else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
        else sock.write('502 nope\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('email delivery', () => {
  it('sends automation output over SMTP with a subject from the first line', async () => {
    const cfg = defaultConfig().platforms;
    cfg.email = { enabled: true, smtpUrl: `smtp://127.0.0.1:${port}`, from: 'Kronos <kronos@example.com>', to: 'me@example.com' };
    await sendPlatformMessage('email', '', '# Günaydın ☀️\n\nToday: 3 meetings.\n.leading dot line', cfg);
    expect(received).toHaveLength(1);
    const mail = received[0]!;
    expect(mail.from).toBe('kronos@example.com');
    expect(mail.to).toEqual(['me@example.com']);
    expect(mail.data).toMatch(/Subject: =\?UTF-8\?B\?/);
    const body = Buffer.from(mail.data.split('\n\n').slice(1).join('').replace(/\s/g, ''), 'base64').toString('utf8');
    expect(body).toContain('Today: 3 meetings.');
    expect(body).toContain('.leading dot line');
  });

  it('refuses to send credentials without TLS', async () => {
    const cfg = defaultConfig().platforms;
    cfg.email = { enabled: true, smtpUrl: `smtp://user:secret@127.0.0.1:${port}`, to: 'me@example.com' };
    await expect(sendPlatformMessage('email', '', 'hi', cfg)).rejects.toThrow(/STARTTLS/);
  });
});
