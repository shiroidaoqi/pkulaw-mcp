import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { connectUpstream } from '../src/upstream.js';
import { UPSTREAM } from '../src/core.js';

test('actual SDK upstream adapter handshake/list/call via mocked fetch only', { timeout: 5000 }, async () => {
  const originalFetch = globalThis.fetch;
  const token = randomBytes(32).toString('hex');
  const calls = [];
  let deletes = 0;
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(String(url), UPSTREAM);
    assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${token}`);
    assert.equal(options.redirect, 'error');
    if (options.method === 'DELETE') { deletes++; return new Response(null, { status: 204 }); }
    if (options.method !== 'POST') return new Response(null, { status: 405 });
    const req = JSON.parse(options.body);
    calls.push(req.method);
    if (req.id === undefined) return new Response(null, { status: 202 });
    let result;
    if (req.method === 'initialize') result = { protocolVersion: req.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'local-mock-not-pkulaw', version: '1.0.0' } };
    else if (req.method === 'tools/list') result = { tools: [{ name: 'mock_only', description: 'test only', inputSchema: { type: 'object' } }] };
    else if (req.method === 'tools/call') result = { content: [{ type: 'text', text: 'mock result' }] };
    else assert.fail('unexpected method');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), { headers: { 'Content-Type': 'application/json', 'mcp-session-id': 'mock-session' } });
  };
  let session;
  try {
    session = await connectUpstream(token, new AbortController().signal);
    assert.equal((await session.listTools({})).tools[0].name, 'mock_only');
    assert.equal((await session.callTool({ name: 'mock_only', arguments: {} })).content[0].text, 'mock result');
    assert.deepEqual(calls, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  } finally { await session?.close(); globalThis.fetch = originalFetch; }
  assert.equal(deletes, 1);
});
