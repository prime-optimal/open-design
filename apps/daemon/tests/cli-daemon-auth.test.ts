import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiTokenAuthorizationMatches } from '../src/api-token-auth.js';
import { createDaemonFetch, operatorAuthHeaders } from '../src/cli-daemon-auth.js';
import { planOdcInvocation } from '../src/odc-launcher.js';

const TOKEN = 'operator-secret';
const DAEMON = 'https://nas.example.ts.net';

function recordingFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit; headers: Headers }> = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init, headers: new Headers(init.headers) });
    return respond(String(input), init);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('operatorAuthHeaders', () => {
  it('sends the operator token as Basic, accepted by the daemon', () => {
    const headers = operatorAuthHeaders(DAEMON, { OD_API_TOKEN: TOKEN });
    expect(headers.authorization).toMatch(/^Basic /);
    expect(apiTokenAuthorizationMatches(headers.authorization, TOKEN)).toBe(true);
  });

  it('is empty without a token or when auth is disabled', () => {
    expect(operatorAuthHeaders(DAEMON, {})).toEqual({});
    expect(operatorAuthHeaders(DAEMON, { OD_API_TOKEN: TOKEN, OD_DISABLE_API_AUTH: '1' })).toEqual({});
  });

  it('refuses plaintext non-loopback daemons but allows loopback http', () => {
    expect(() => operatorAuthHeaders('http://nas.example.ts.net:7456', { OD_API_TOKEN: TOKEN })).toThrow(/https/);
    expect(operatorAuthHeaders('http://127.0.0.1:7456', { OD_API_TOKEN: TOKEN }).authorization).toBeDefined();
  });
});

describe('createDaemonFetch', () => {
  const env = { OD_API_TOKEN: TOKEN };

  it('attaches operator auth only to trusted daemon origins and keeps other headers', async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response('ok'));
    const daemonFetch = createDaemonFetch({ env, fetchImpl, trusted: new Set([DAEMON]) });

    await daemonFetch(`${DAEMON}/api/projects`, {
      headers: { 'x-od-workspace-id': 'w1', 'x-od-analytics': 'a' },
    });
    await daemonFetch('https://api.provider.example/v1/models');

    expect(calls[0]!.headers.get('authorization')).toMatch(/^Basic /);
    expect(calls[0]!.headers.get('x-od-workspace-id')).toBe('w1');
    expect(calls[0]!.headers.get('x-od-analytics')).toBe('a');
    expect(calls[1]!.headers.has('authorization')).toBe(false);
  });

  it('passes everything through when no token is configured', async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response('ok'));
    const daemonFetch = createDaemonFetch({ env: {}, fetchImpl, trusted: new Set([DAEMON]) });
    await daemonFetch(`${DAEMON}/api/projects`);
    expect(calls[0]!.headers.has('authorization')).toBe(false);
  });

  it('preserves run-scoped Bearer grants in any header spelling', async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response('ok'));
    const daemonFetch = createDaemonFetch({ env, fetchImpl, trusted: new Set([DAEMON]) });

    await daemonFetch(`${DAEMON}/a`, { headers: { Authorization: 'Bearer run-grant' } });
    await daemonFetch(`${DAEMON}/b`, { headers: new Headers({ authorization: 'Bearer run-grant' }) });
    await daemonFetch(`${DAEMON}/c`, { headers: [['AUTHORIZATION', 'Bearer run-grant']] });

    for (const call of calls) expect(call.headers.get('authorization')).toBe('Bearer run-grant');
  });

  it('follows same-origin redirects with credentials and rewrites POST on 303', async () => {
    const { calls, fetchImpl } = recordingFetch((target) =>
      target.endsWith('/old')
        ? new Response(null, { status: 303, headers: { location: '/new' } })
        : new Response('done'),
    );
    const daemonFetch = createDaemonFetch({ env, fetchImpl, trusted: new Set([DAEMON]) });

    const response = await daemonFetch(`${DAEMON}/old`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(await response.text()).toBe('done');
    expect(calls.map((call) => call.url)).toEqual([`${DAEMON}/old`, `${DAEMON}/new`]);
    expect(calls[1]!.headers.get('authorization')).toMatch(/^Basic /);
    expect(calls[1]!.init.method).toBe('GET');
    expect(calls[1]!.init.body).toBeUndefined();
  });

  it('never replays credentials to a different origin on redirect', async () => {
    const { calls, fetchImpl } = recordingFetch(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }),
    );
    const daemonFetch = createDaemonFetch({ env, fetchImpl, trusted: new Set([DAEMON]) });

    await expect(daemonFetch(`${DAEMON}/x`)).rejects.toThrow(/different origin/);
    expect(calls).toHaveLength(1);
  });

  it('does not intercept redirects of requests that carry their own grant', async () => {
    const { calls, fetchImpl } = recordingFetch(
      () => new Response(null, { status: 302, headers: { location: 'https://cdn.example/file' } }),
    );
    const daemonFetch = createDaemonFetch({ env, fetchImpl, trusted: new Set([DAEMON]) });

    const response = await daemonFetch(`${DAEMON}/x`, { headers: { authorization: 'Bearer g' } });
    expect(response.status).toBe(302);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.redirect).toBeUndefined();
  });
});

describe('planOdcInvocation', () => {
  it('turns bare odc into help instead of starting a daemon', () => {
    expect(planOdcInvocation([], {})).toMatchObject({ ok: true, argv: ['--help'] });
  });

  it('rejects daemon-start flags', () => {
    expect(planOdcInvocation(['--port', '1234'], { ODC_DAEMON_URL: DAEMON })).toMatchObject({ ok: false });
  });

  it('requires an explicit daemon for client commands but not for help', () => {
    expect(planOdcInvocation(['project', 'list'], {})).toMatchObject({ ok: false });
    expect(planOdcInvocation(['project', '--help'], {})).toMatchObject({ ok: true });
    expect(planOdcInvocation(['project', 'list', '--daemon-url', DAEMON], {})).toMatchObject({ ok: true });
    expect(planOdcInvocation(['project', 'list', `--daemon-url=${DAEMON}`], {})).toMatchObject({ ok: true });
  });

  it('maps ODC_DAEMON_URL onto OD_DAEMON_URL', () => {
    const plan = planOdcInvocation(['project', 'list'], { ODC_DAEMON_URL: DAEMON });
    expect(plan).toMatchObject({ ok: true });
    if (plan.ok) expect(plan.env.OD_DAEMON_URL).toBe(DAEMON);
  });
});

describe('od CLI against a token-protected daemon', () => {
  const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
  const CLI_SRC = path.join(__dirname, '../src/cli.ts');
  const TSX_CLI = path.join(path.resolve(__dirname, '../../..'), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const seen: Array<{ path: string; authorization: string | undefined; workspace: string | undefined }> = [];
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({
        path: req.url ?? '',
        authorization: req.headers.authorization,
        workspace: req.headers['x-od-workspace-id'] as string | undefined,
      });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/workspace/directory') res.end(JSON.stringify({ items: [] }));
      else if (req.url?.startsWith('/api/media/models')) res.end('{}');
      else res.end(JSON.stringify({ projects: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string }> {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, OD_DAEMON_URL: baseUrl };
    delete childEnv.NODE_OPTIONS;
    delete childEnv.OD_API_TOKEN;
    delete childEnv.OD_TOOL_TOKEN;
    Object.assign(childEnv, env);
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [TSX_CLI, CLI_SRC, ...args], {
        cwd: path.join(__dirname, '..'),
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('CLI timed out')); }, 30_000);
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout }); });
    });
  }

  it('sends the operator token on project calls and extracted helper calls', async () => {
    seen.length = 0;
    const result = await runCli(['project', 'list', '--json'], { OD_API_TOKEN: TOKEN });
    expect(result.code).toBe(0);
    const paths = seen.map((entry) => entry.path);
    expect(paths).toContain('/api/workspace/directory');
    expect(paths).toContain('/api/projects');
    for (const entry of seen) expect(apiTokenAuthorizationMatches(entry.authorization, TOKEN)).toBe(true);
  });

  it('keeps a run-scoped Bearer grant instead of the operator token', async () => {
    seen.length = 0;
    const result = await runCli(['media', 'models'], { OD_API_TOKEN: TOKEN, OD_TOOL_TOKEN: 'run-grant' });
    expect(result.code).toBe(0);
    expect(seen.map((entry) => entry.authorization)).toEqual(['Bearer run-grant']);
  });

  it('sends no credentials when no operator token is configured', async () => {
    seen.length = 0;
    const result = await runCli(['project', 'list', '--json'], {});
    expect(result.code).toBe(0);
    for (const entry of seen) expect(entry.authorization).toBeUndefined();
  });
});
