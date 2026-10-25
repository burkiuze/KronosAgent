import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

export interface MailMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
}

/**
 * Minimal SMTP client for delivering automation results and notifications by email.
 * smtpUrl: smtps://user:pass@host:465 (implicit TLS) or smtp://user:pass@host:587 (STARTTLS when
 * offered; required when credentials are present). Credentials may be URL-encoded.
 */
export async function sendMail(smtpUrl: string, msg: MailMessage, opts: { timeoutMs?: number } = {}): Promise<void> {
  const url = new URL(smtpUrl);
  const secure = url.protocol === 'smtps:';
  if (!secure && url.protocol !== 'smtp:') throw new Error('smtpUrl must start with smtp:// or smtps://');
  const host = url.hostname;
  const port = Number(url.port || (secure ? 465 : 587));
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  const timeoutMs = opts.timeoutMs ?? 20_000;

  let socket: Socket | TLSSocket = secure ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
  socket.setTimeout(timeoutMs);
  let buffer = '';
  let waiter: { resolve: (r: { code: number; lines: string[] }) => void; reject: (e: Error) => void } | null = null;
  let failure: Error | null = null;

  const pump = () => {
    // a reply is complete when a line has "NNN " (space, not dash) after the code
    const lines = buffer.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i] as string) || /^\d{3}$/.test(lines[i] as string)) {
        const reply = lines.slice(0, i + 1);
        buffer = lines.slice(i + 1).join('\r\n');
        const w = waiter;
        waiter = null;
        w?.resolve({ code: Number((lines[i] as string).slice(0, 3)), lines: reply });
        return;
      }
    }
  };
  const attach = (s: Socket | TLSSocket) => {
    s.on('data', (d: Buffer) => {
      buffer += d.toString('utf8');
      pump();
    });
    s.on('error', (e: Error) => {
      failure = e;
      waiter?.reject(e);
    });
    s.on('timeout', () => {
      failure = new Error(`SMTP timeout talking to ${host}:${port}`);
      waiter?.reject(failure);
      s.destroy();
    });
  };
  attach(socket);

  const read = () =>
    new Promise<{ code: number; lines: string[] }>((resolve, reject) => {
      if (failure) return reject(failure);
      waiter = { resolve, reject };
      pump();
    });
  const cmd = async (line: string, expect: number[], label = line.split(' ')[0]) => {
    socket.write(`${line}\r\n`);
    const r = await read();
    if (!expect.includes(r.code)) throw new Error(`SMTP ${label} failed: ${r.lines.join(' ').slice(0, 300)}`);
    return r;
  };

  try {
    const greet = await read();
    if (greet.code !== 220) throw new Error(`SMTP greeting failed: ${greet.lines.join(' ')}`);
    const me = hostname() || 'kronos.local';
    let ehlo = await cmd(`EHLO ${me}`, [250]);
    const supportsTls = ehlo.lines.some((l) => /STARTTLS/i.test(l));
    if (!secure && (supportsTls || user)) {
      if (!supportsTls) throw new Error('SMTP server does not offer STARTTLS; refusing to send credentials in clear text');
      await cmd('STARTTLS', [220]);
      const plain = socket as Socket;
      plain.removeAllListeners('data');
      socket = await new Promise<TLSSocket>((resolve, reject) => {
        const t = tlsConnect({ socket: plain, servername: host }, () => resolve(t));
        t.once('error', reject);
      });
      socket.setTimeout(timeoutMs);
      buffer = '';
      attach(socket);
      ehlo = await cmd(`EHLO ${me}`, [250]);
    }
    if (user) {
      const auth = ehlo.lines.find((l) => /AUTH/i.test(l)) ?? '';
      if (/PLAIN/i.test(auth) || !/LOGIN/i.test(auth)) {
        await cmd(`AUTH PLAIN ${Buffer.from(`\u0000${user}\u0000${pass}`).toString('base64')}`, [235], 'AUTH');
      } else {
        await cmd('AUTH LOGIN', [334], 'AUTH');
        await cmd(Buffer.from(user).toString('base64'), [334], 'AUTH');
        await cmd(Buffer.from(pass).toString('base64'), [235], 'AUTH');
      }
    }
    const addr = (s: string) => /<([^>]+)>/.exec(s)?.[1] ?? s.trim();
    await cmd(`MAIL FROM:<${addr(msg.from)}>`, [250], 'MAIL FROM');
    for (const to of msg.to) await cmd(`RCPT TO:<${addr(to)}>`, [250, 251], 'RCPT TO');
    await cmd('DATA', [354]);
    await cmd(`${formatMessage(msg, host)}\r\n.`, [250], 'DATA');
    socket.write('QUIT\r\n');
  } finally {
    socket.end();
  }
}

function encodeHeader(value: string): string {
  // RFC 2047 encoded-word for non-ASCII subjects
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function formatMessage(msg: MailMessage, host: string): string {
  const body = Buffer.from(msg.text.replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/.{76}/g, '$&\r\n');
  const headers = [
    `From: ${msg.from}`,
    `To: ${msg.to.join(', ')}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${host}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'X-Mailer: Kronos Agent',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}
