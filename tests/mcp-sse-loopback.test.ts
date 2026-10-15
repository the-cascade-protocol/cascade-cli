import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import { createServer, startSSEServer } from '../src/lib/mcp/server.js';

function get(port: number, host: string, path = '/health'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

function connectError(address: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: address, port, timeout: 2000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(null);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve('ETIMEDOUT');
    });
    socket.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'error'));
  });
}

describe('cascade serve --mcp --transport sse answers this machine only', () => {
  let httpServer: http.Server;
  let port: number;

  beforeAll(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    httpServer = await startSSEServer(createServer(), 0);
    port = (httpServer.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
    vi.restoreAllMocks();
  });

  it('binds the loopback address, not every interface', () => {
    expect((httpServer.address() as net.AddressInfo).address).toBe('127.0.0.1');
  });

  it('refuses a connection over any non-loopback address of this machine', async () => {
    const external = Object.values(os.networkInterfaces())
      .flat()
      .filter((i): i is os.NetworkInterfaceInfo => !!i && !i.internal && i.family === 'IPv4')
      .map((i) => i.address);
    for (const address of external) {
      expect(await connectError(address, port), address).not.toBeNull();
    }
  });

  it('answers a request addressed to 127.0.0.1 or localhost, with no Origin header', async () => {
    expect(await get(port, `127.0.0.1:${port}`)).toBe(200);
    expect(await get(port, `localhost:${port}`)).toBe(200);
  });

  it('refuses a request whose Host is another name (DNS rebinding)', async () => {
    expect(await get(port, `evil.example:${port}`)).toBe(403);
    expect(await get(port, `127.0.0.1.evil.example:${port}`)).toBe(403);
    expect(await get(port, `evil.example:${port}`, '/sse')).toBe(403);
  });

  it('reports a port already in use as an error rather than crashing later', async () => {
    await expect(startSSEServer(createServer(), port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});
