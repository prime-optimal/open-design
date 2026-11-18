import {
  API_TOKEN_BASIC_USERNAME,
  apiTokenFromEnv,
  isApiAuthDisabled,
} from './api-token-auth.js';
import { resolveDaemonUrl, type ResolveDaemonUrlOptions } from './daemon-url.js';

/**
 * Operator authentication for CLI calls to the configured daemon.
 *
 * The operator token (`OD_API_TOKEN`, supplied through the environment, e.g. by
 * fnox) is sent as HTTP Basic so it never collides with the run-scoped Bearer
 * lane (`OD_TOOL_TOKEN`). A request that already carries an `Authorization`
 * header keeps it untouched. Credentials are attached only for the origin the
 * CLI resolved as its daemon, and redirects are followed manually so a token is
 * never replayed to another origin.
 */

const MAX_REDIRECTS = 5;
const trustedOrigins = new Set<string>();

type FetchLike = typeof fetch;

function originOf(url: string | URL): string | null {
  try {
    return new URL(String(url)).origin;
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Basic operator header for `daemonUrl`, or `{}` when no operator token is
 * configured. Refuses to hand a token to a plaintext non-loopback endpoint.
 */
export function operatorAuthHeaders(
  daemonUrl: string | URL,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const token = apiTokenFromEnv(env);
  if (!token || isApiAuthDisabled(env)) return {};
  let url: URL;
  try {
    url = new URL(String(daemonUrl));
  } catch {
    throw new Error(`invalid daemon URL: ${String(daemonUrl)}`);
  }
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
    throw new Error(
      `refusing to send OD_API_TOKEN over ${url.protocol}// to ${url.host}; use an https daemon URL`,
    );
  }
  const basic = Buffer.from(`${API_TOKEN_BASIC_USERNAME}:${token}`, 'utf8').toString('base64');
  return { authorization: `Basic ${basic}` };
}

export function trustDaemonOrigin(daemonUrl: string | URL): void {
  const origin = originOf(daemonUrl);
  if (origin) trustedOrigins.add(origin);
}

/** Resolve the CLI daemon URL and mark its origin as eligible for operator credentials. */
export async function resolveCliDaemonUrl(options: ResolveDaemonUrlOptions = {}): Promise<string> {
  const url = await resolveDaemonUrl(options);
  trustDaemonOrigin(url);
  return url;
}

function redirectedInit(init: RequestInit, status: number): RequestInit {
  const method = (init.method ?? 'GET').toUpperCase();
  const toGet = status === 303
    ? method !== 'HEAD'
    : (status === 301 || status === 302) && method === 'POST';
  if (!toGet) return init;
  const headers = new Headers(init.headers);
  headers.delete('content-type');
  headers.delete('content-length');
  const { body: _body, ...rest } = init;
  return { ...rest, method: 'GET', headers };
}

export interface DaemonFetchOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  /** Origins that may receive operator credentials; defaults to the shared set. */
  trusted?: ReadonlySet<string>;
}

export function createDaemonFetch(options: DaemonFetchOptions = {}): FetchLike {
  const env = options.env ?? process.env;
  const trusted = options.trusted ?? trustedOrigins;
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    if (typeof input !== 'string' && !(input instanceof URL)) return fetchImpl(input, init);
    const origin = originOf(input);
    if (!origin || !trusted.has(origin)) return fetchImpl(input, init);

    const headers = new Headers(init.headers);
    if (headers.has('authorization')) return fetchImpl(input, init);
    const auth = operatorAuthHeaders(input, env);
    if (!auth.authorization) return fetchImpl(input, init);
    headers.set('authorization', auth.authorization);

    // Follow redirects ourselves: same-origin hops keep the credential,
    // anything else is rejected rather than replayed or silently dropped.
    let currentUrl = String(input);
    let currentInit: RequestInit = { ...init, headers, redirect: 'manual' };
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await fetchImpl(currentUrl, currentInit);
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || !location) return response;
      if (init.redirect === 'manual') return response;
      if (init.redirect === 'error') throw new TypeError(`unexpected redirect from ${currentUrl}`);
      const next = new URL(location, currentUrl);
      if (next.origin !== origin) {
        throw new Error(
          `daemon redirected to a different origin (${next.origin}); refusing to forward operator credentials`,
        );
      }
      await response.body?.cancel().catch(() => undefined);
      currentUrl = next.toString();
      currentInit = redirectedInit(currentInit, response.status);
    }
    throw new Error(`too many redirects from daemon at ${origin}`);
  }) as FetchLike;
}

/** Shared fetch for configured-daemon calls; use instead of global `fetch` for daemon URLs. */
export const daemonFetch: FetchLike = createDaemonFetch();
