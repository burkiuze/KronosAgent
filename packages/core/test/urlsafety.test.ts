import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { safeFetch, urlBlocked } from '../src/util/urlsafety.js';

describe('URL safety', () => {
  it('never fetches cloud metadata or link-local addresses, but allows local dev servers', async () => {
    for (const u of ['http://169.254.169.254/latest/meta-data/', 'http://metadata.google.internal/computeMetadata/v1/', 'http://100.100.100.200/', 'http://[fd00:ec2::254]/', 'http://169.254.1.1:8080/']) expect(await urlBlocked(u)).toMatch(/metadata \/ link-local/);
    expect(await urlBlocked('file:///etc/passwd')).toMatch(/only http and https/);
    expect(await urlBlocked('http://localhost:3000/')).toBeUndefined();
    expect(await urlBlocked('http://192.168.1.10/')).toBeUndefined();
  });

  it('checks every redirect hop', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/go') return res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/iam' }).end();
      res.end('fine');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await (await safeFetch(`${base}/ok`)).text()).toBe('fine');
      await expect(safeFetch(`${base}/go`)).rejects.toThrow(/Blocked: 169\.254\.169\.254/);
    } finally {
      server.close();
    }
  });
});
