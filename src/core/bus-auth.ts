/**
 * Shared bus-token plumbing for AgentBus's own HTTP clients.
 *
 * When `bus.auth_token` is set, bus-core rejects every request except
 * `GET /api/v1/health` that lacks a matching `X-Bus-Token` header (see
 * src/http/api.ts). Every internal client — the cc.ts MCP server and its
 * polling loop, cc-headless, the cc-pool manager and pane readiness poll —
 * talks to the bus over HTTP, so each one has to send that header too.
 *
 * Token resolution order: the loaded config's `bus.auth_token`, then the
 * `AGENTBUS_BUS_TOKEN` environment variable. Child processes (cc.ts under
 * cc-headless, pool panes and their hook scripts) also receive the token
 * through `AGENTBUS_BUS_TOKEN`. With no token configured, nothing here
 * changes any request.
 */

export const BUS_TOKEN_HEADER = 'X-Bus-Token';
export const BUS_TOKEN_ENV = 'AGENTBUS_BUS_TOKEN';

/** The bus token to send, or undefined when none is configured. Empty strings count as unset. */
export function resolveBusToken(
  config?: { bus?: { auth_token?: string | undefined } } | null,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromConfig = config?.bus?.auth_token;
  if (fromConfig) return fromConfig;
  const fromEnv = env[BUS_TOKEN_ENV];
  return fromEnv ? fromEnv : undefined;
}

/** `{ AGENTBUS_BUS_TOKEN: token }` when a token is set, else `{}` — for spreading into a child env. */
export function busTokenEnv(token: string | undefined): Record<string, string> {
  return token ? { [BUS_TOKEN_ENV]: token } : {};
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function targetsBus(url: string, baseUrl: string): boolean {
  const base = baseUrl.replace(/\/+$/, '');
  return url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`);
}

/**
 * Wrap a fetch so requests to `baseUrl` carry `X-Bus-Token`. Requests to any
 * other host pass through untouched, and an explicit `X-Bus-Token` header on
 * the request is never overwritten. When `token` is unset the base fetch is
 * returned as-is.
 *
 * `base` defaults to whatever `globalThis.fetch` is at call time (not at wrap
 * time), so tests that stub the global fetch still intercept wrapped calls.
 */
export function withBusToken(
  baseUrl: string,
  token: string | undefined,
  base?: typeof fetch,
): typeof fetch {
  const callBase: typeof fetch = base ?? ((input, init) => globalThis.fetch(input, init));
  if (!token) return callBase;
  const wrapped = (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    if (!targetsBus(requestUrl(input), baseUrl)) return callBase(input, init);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (!headers.has(BUS_TOKEN_HEADER)) headers.set(BUS_TOKEN_HEADER, token);
    return callBase(input, { ...init, headers });
  };
  return wrapped as typeof fetch;
}

/**
 * Patch `globalThis.fetch` so every request this process makes to the bus
 * carries the token. Used by the standalone cc.ts process, where every MCP
 * tool and the polling loop share the global fetch. No-op when `token` is unset.
 */
export function installBusTokenFetch(baseUrl: string, token: string | undefined): void {
  if (!token) return;
  const original = globalThis.fetch;
  globalThis.fetch = withBusToken(baseUrl, token, original);
}
