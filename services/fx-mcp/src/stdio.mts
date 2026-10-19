// fx-mcp over stdio: the way desktop assistants start a local MCP server. npm run mcp:stdio
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.ts';

const { server } = buildServer();
await server.connect(new StdioServerTransport());
// stdout carries the protocol; anything human goes to stderr
console.error('fx-mcp ready on stdio');
