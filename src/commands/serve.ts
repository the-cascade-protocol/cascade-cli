/**
 * cascade serve
 *
 * Start a local MCP-compatible agent server that exposes Cascade Protocol
 * tools to AI agents.
 *
 * Transports:
 *   stdio  — Standard input/output (for Claude Desktop, Claude Code)
 *   sse    — Server-Sent Events over HTTP (for web-based agents)
 *
 * Options:
 *   --mcp                     Enable MCP (Model Context Protocol) mode
 *   --transport <transport>   Transport type (stdio|sse) [default: stdio]
 *   --port <port>             Port for SSE transport [default: 3000]
 *   --pod <path>              Default Pod directory path
 *
 * Environment Variables:
 *   CASCADE_POD_PATH          Default Pod directory (overridden by --pod)
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

import { Command } from 'commander';
import { printError, printVerbose, type OutputOptions } from '../lib/output.js';
import { startServer } from '../lib/mcp/server.js';

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Start local agent server')
    .option('--mcp', 'Enable MCP (Model Context Protocol) mode')
    .option('--transport <transport>', 'Transport type (stdio|sse)', 'stdio')
    .option('--port <port>', 'Port for SSE transport', '3000')
    .option('--pod <path>', 'Default Pod directory path')
    .action(
      async (options: {
        mcp?: boolean;
        transport: string;
        port: string;
        pod?: string;
      }) => {
        const globalOpts = program.opts() as OutputOptions;

        if (!options.mcp) {
          printError(
            'The --mcp flag is required. Usage: cascade serve --mcp',
            globalOpts,
          );
          console.error('');
          console.error('Examples:');
          console.error('  cascade serve --mcp                           # stdio transport');
          console.error('  cascade serve --mcp --transport sse --port 3000  # SSE transport');
          console.error('  cascade serve --mcp --pod ./my-pod            # with default Pod');
          process.exitCode = 1;
          return;
        }

        const transport = options.transport as 'stdio' | 'sse';
        if (transport !== 'stdio' && transport !== 'sse') {
          printError(
            `Invalid transport: "${options.transport}". Must be "stdio" or "sse".`,
            globalOpts,
          );
          process.exitCode = 1;
          return;
        }

        printVerbose(`Starting MCP server with transport: ${transport}`, globalOpts);

        try {
          await startServer({
            transport,
            port: parseInt(options.port, 10),
            podPath: options.pod,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          printError(`Failed to start server: ${message}`, globalOpts);
          process.exitCode = 1;
        }
      },
    );
}
