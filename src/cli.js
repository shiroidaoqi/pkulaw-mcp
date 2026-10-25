#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createBridge } from './core.js';
import { connectUpstream } from './upstream.js';
const bridge = createBridge({ token: process.env.PKULAW_TOKEN, connect: connectUpstream });
const server = new Server({ name: 'pkulaw-tokenless-bridge', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => bridge.listTools());
server.setRequestHandler(CallToolRequestSchema, async req => bridge.callTool(req.params.name, req.params.arguments));
server.onerror = () => {}; // SDK errors may contain upstream details; never log them.
try { await server.connect(new StdioServerTransport()); }
catch { process.stderr.write('MCP startup failed.\n'); process.exitCode = 1; }
