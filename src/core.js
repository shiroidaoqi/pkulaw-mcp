export const UPSTREAM = 'https://apim-gateway.pkulaw.com/mcp-law-agg/1.0.0/mcp';
export const MAX_INPUT = 128 * 1024;
export const MAX_OUTPUT = 1024 * 1024;
export const TIMEOUT_MS = 30_000;
const text = value => ({ content: [{ type: 'text', text: value }] });
const failure = message => ({ ...text(message), isError: true });
export const TOOLS = [
  {
    name: 'pkulaw_list_upstream_tools',
    description: '使用本实例用户自己的法宝凭据读取官方聚合MCP真实工具名称和schema。无凭据将失败；不是公开匿名服务。可用nextCursor分页。',
    inputSchema: { type: 'object', properties: { cursor: { type: 'string', maxLength: 4096 } }, additionalProperties: false }
  },
  {
    name: 'pkulaw_call_upstream_tool',
    description: '按pkulaw_list_upstream_tools返回的真实name/schema调用官方工具。arguments不可放入凭据；凭据仅由实例环境配置。本工具不是18个原生工具的schema直通。',
    inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 256 }, arguments: { type: 'object' } }, required: ['name', 'arguments'], additionalProperties: false }
  }
];

function validToken(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 && /^[\x21-\x7e]+$/.test(value);
}
function validInput(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (Buffer.byteLength(JSON.stringify(args)) > MAX_INPUT) return false;
  const keys = Object.keys(args);
  if (name === TOOLS[0].name) return keys.every(k => k === 'cursor') && (args.cursor === undefined || (typeof args.cursor === 'string' && args.cursor.length <= 4096));
  if (name === TOOLS[1].name) return keys.every(k => ['name', 'arguments'].includes(k)) && typeof args.name === 'string' && args.name.length > 0 && args.name.length <= 256 && args.arguments !== null && typeof args.arguments === 'object' && !Array.isArray(args.arguments);
  return false;
}
function redact(serialized, token) {
  // Defense in depth against accidental upstream credential echoes, not a guarantee
  // against an actively malicious upstream transforming/exfiltrating credentials.
  for (const value of [JSON.stringify(token).slice(1, -1), encodeURIComponent(token), Buffer.from(token).toString('base64')]) {
    serialized = serialized.split(value).join('[REDACTED]');
  }
  return serialized;
}
export function createBridge({ token, connect }) {
  // Credentials are captured per isolated process; no global mutable user/session cache.
  return {
    listTools: () => ({ tools: structuredClone(TOOLS) }),
    async callTool(name, args = {}) {
      if (!validInput(name, args)) return failure('INVALID_INPUT: unknown wrapper tool, invalid arguments or request too large.');
      if (!validToken(token)) return failure('PKULAW_TOKEN_REQUIRED: configure your own PKULAW_TOKEN in this private instance environment; never place it in tool arguments.');
      let session;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        session = await connect(token, controller.signal);
        const result = name === TOOLS[0].name
          ? await session.listTools(args.cursor === undefined ? {} : { cursor: args.cursor })
          : await session.callTool({ name: args.name, arguments: args.arguments });
        if (name === TOOLS[1].name && result.isError) return failure('PKULAW_TOOL_ERROR: upstream tool failed; upstream diagnostics withheld.');
        const serialized = JSON.stringify(result);
        if (Buffer.byteLength(serialized) > MAX_OUTPUT) return failure('PKULAW_RESPONSE_TOO_LARGE');
        return text(redact(serialized, token));
      } catch {
        // Never emit upstream bodies, request headers, exception messages or stacks.
        return failure('PKULAW_UPSTREAM_ERROR: check your token, account permissions and upstream availability.');
      } finally {
        try { await session?.close(); } catch { /* deliberately silent */ }
        controller.abort();
        clearTimeout(timer);
      }
    }
  };
}

export function boundedFetch(token, operationSignal, fetchImpl = fetch) {
  return async (url, options = {}) => {
    if (String(url) !== UPSTREAM) throw new Error('UPSTREAM_NOT_ALLOWED');
    if (!['POST', 'GET', 'DELETE'].includes(options.method ?? 'GET')) throw new Error('METHOD_NOT_ALLOWED');
    if (options.body != null && (typeof options.body !== 'string' || Buffer.byteLength(options.body) > MAX_INPUT)) throw new Error('REQUEST_TOO_LARGE');
    const incoming = new Headers(options.headers);
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    // Never forward arbitrary inbound headers/cookies/credentials or let SDK override auth.
    for (const key of ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id']) {
      if (incoming.has(key)) headers.set(key, incoming.get(key));
    }
    const response = await fetchImpl(UPSTREAM, { ...options, headers, redirect: 'error', credentials: 'omit', signal: options.signal ? AbortSignal.any([operationSignal, options.signal]) : operationSignal });
    if (!response.ok) {
      await response.body?.cancel();
      // Streamable HTTP permits servers to omit the standalone SSE GET stream.
      if ((options.method ?? 'GET') === 'GET' && response.status === 405) return new Response(null, { status: 405 });
      throw new Error('UPSTREAM_HTTP_ERROR');
    }
    if (Number(response.headers.get('content-length')) > MAX_OUTPUT) { await response.body?.cancel(); throw new Error('RESPONSE_TOO_LARGE'); }
    if (!response.body) return response;
    let size = 0;
    const limited = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > MAX_OUTPUT) throw new Error('RESPONSE_TOO_LARGE');
      controller.enqueue(chunk);
    } }));
    return new Response(limited, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
