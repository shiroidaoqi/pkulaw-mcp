import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

test('actual official SDK stdio initialize/list_tools/call without credentials', { timeout: 10000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/cli.js', import.meta.url))],
    env: { PKULAW_TOKEN: '' }, stderr: 'pipe'
  });
  let stderr = '';
  transport.stderr?.on('data', data => { stderr += data.toString(); });
  const client = new Client({ name: 'local-mock-check', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(t => t.name), ['pkulaw_list_upstream_tools', 'pkulaw_call_upstream_tool']);
    const missing = await client.callTool({ name: listed.tools[0].name, arguments: {} });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /PKULAW_TOKEN_REQUIRED/);
    const missingCall = await client.callTool({ name: listed.tools[1].name, arguments: { name: 'mock_only', arguments: {} } });
    assert.equal(missingCall.isError, true);
    assert.match(missingCall.content[0].text, /PKULAW_TOKEN_REQUIRED/);
    assert.equal(stderr, '');
  } finally { await client.close(); }
});
