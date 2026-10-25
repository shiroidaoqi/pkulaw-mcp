import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boundedFetch, UPSTREAM, TIMEOUT_MS } from './core.js';
export async function connectUpstream(token, signal) {
  const client = new Client({ name: 'pkulaw-tokenless-bridge', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(UPSTREAM), {
    fetch: boundedFetch(token, signal),
    requestInit: { headers: { Authorization: `Bearer ${token}` }, signal }
  });
  try {
    await client.connect(transport, { timeout: TIMEOUT_MS, signal });
    return {
      listTools: params => client.listTools(params, { timeout: TIMEOUT_MS, signal }),
      callTool: params => client.callTool(params, undefined, { timeout: TIMEOUT_MS, signal }),
      close: async () => {
        // SDK close() only closes local transport. Best-effort delete the remote
        // session too; never extend cleanup beyond 2 seconds.
        let timer;
        try {
          await Promise.race([
            transport.terminateSession(),
            new Promise(resolve => { timer = setTimeout(resolve, 2000); })
          ]);
        } catch { /* server may not implement DELETE; never expose diagnostics */ }
        finally { clearTimeout(timer); await client.close(); }
      }
    };
  } catch {
    await client.close().catch(() => {});
    throw new Error('UPSTREAM_CONNECT_FAILED');
  }
}
