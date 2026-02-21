/**
 * Cascade Protocol MCP Server.
 *
 * Provides a local MCP-compatible server that exposes Cascade Protocol
 * tools to AI agents. Supports stdio and SSE transports.
 *
 * All operations are local — zero network calls.
 *
 * Usage:
 *   cascade serve --mcp                          (stdio transport)
 *   cascade serve --mcp --transport sse --port 3000  (SSE transport)
 *
 * Claude Desktop configuration:
 *   {
 *     "mcpServers": {
 *       "cascade": {
 *         "command": "cascade",
 *         "args": ["serve", "--mcp"],
 *         "env": { "CASCADE_POD_PATH": "/path/to/pod" }
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools, setDefaultPodPath } from './tools.js';

export interface ServeOptions {
  transport: 'stdio' | 'sse';
  port: number;
  podPath?: string;
}

/**
 * Create and configure the MCP server with all Cascade tools.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: 'cascade-protocol',
      version: '0.2.0',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        'Cascade Protocol MCP Server — Local-first access to structured health data. ' +
        'Use cascade_capabilities to discover all available tools. ' +
        'All operations are local (zero network calls). ' +
        'All agent-written data is automatically tagged with AIGenerated provenance. ' +
        'Set CASCADE_POD_PATH environment variable to specify the default Pod directory.',
    },
  );

  // Register all tools
  registerTools(server);

  return server;
}

/**
 * Start the MCP server with the specified transport.
 */
export async function startServer(options: ServeOptions): Promise<void> {
  // Set default Pod path from env or option
  const podPath = options.podPath ?? process.env['CASCADE_POD_PATH'];
  if (podPath) {
    setDefaultPodPath(podPath);
  }

  const server = createServer();

  if (options.transport === 'stdio') {
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Log to stderr so it doesn't interfere with stdio transport
    console.error('[cascade] MCP server started (stdio transport)');
    if (podPath) {
      console.error(`[cascade] Default Pod path: ${podPath}`);
    } else {
      console.error('[cascade] No default Pod path set. Pass "path" argument to tools or set CASCADE_POD_PATH.');
    }
  } else if (options.transport === 'sse') {
    // SSE transport requires an HTTP server
    await startSSEServer(server, options.port, podPath);
  } else {
    throw new Error(`Unsupported transport: ${options.transport}`);
  }
}

/**
 * Start an SSE-based MCP server on the specified port.
 */
async function startSSEServer(server: McpServer, port: number, podPath?: string): Promise<void> {
  // Dynamic import to avoid loading http module for stdio transport
  const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
  const http = await import('http');

  // Track active transports for cleanup
  const transports = new Map<string, InstanceType<typeof SSEServerTransport>>();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    // CORS headers for web agents
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/sse' && req.method === 'GET') {
      // Create a new SSE transport for this connection
      const transport = new SSEServerTransport('/messages', res);
      const sessionId = transport.sessionId;
      transports.set(sessionId, transport);

      // Clean up on disconnect
      res.on('close', () => {
        transports.delete(sessionId);
      });

      await server.connect(transport);
    } else if (url.pathname === '/messages' && req.method === 'POST') {
      // Find the transport by session ID from query params
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing sessionId' }));
        return;
      }

      const transport = transports.get(sessionId)!;
      await transport.handlePostMessage(req, res);
    } else if (url.pathname === '/health' && req.method === 'GET') {
      // Health check endpoint
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        server: 'cascade-protocol',
        version: '0.2.0',
        transport: 'sse',
        activeSessions: transports.size,
        podPath: podPath ?? 'not set',
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Not found',
        endpoints: {
          '/sse': 'SSE connection endpoint (GET)',
          '/messages': 'Message endpoint (POST)',
          '/health': 'Health check (GET)',
        },
      }));
    }
  });

  httpServer.listen(port, () => {
    console.error(`[cascade] MCP server started (SSE transport)`);
    console.error(`[cascade] Listening on http://localhost:${port}`);
    console.error(`[cascade] SSE endpoint: http://localhost:${port}/sse`);
    console.error(`[cascade] Health check: http://localhost:${port}/health`);
    if (podPath) {
      console.error(`[cascade] Default Pod path: ${podPath}`);
    }
  });
}
