/**
 * cascade serve
 *
 * Start local agent server (Phase 3 placeholder).
 *
 * Options:
 *   --mcp                     Enable MCP (Model Context Protocol) mode
 *   --transport <transport>   Transport type (stdio|sse) [default: stdio]
 *   --port <port>             Port for SSE transport [default: 3000]
 */

import { Command } from 'commander';
import { printError, printVerbose, type OutputOptions } from '../lib/output.js';

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Start local agent server')
    .option('--mcp', 'Enable MCP (Model Context Protocol) mode')
    .option('--transport <transport>', 'Transport type (stdio|sse)', 'stdio')
    .option('--port <port>', 'Port for SSE transport', '3000')
    .action(
      async (options: {
        mcp?: boolean;
        transport: string;
        port: string;
      }) => {
        const globalOpts = program.opts() as OutputOptions;

        printVerbose(`Starting server with transport: ${options.transport}`, globalOpts);
        if (options.mcp) {
          printVerbose('MCP mode enabled', globalOpts);
        }
        if (options.transport === 'sse') {
          printVerbose(`SSE port: ${options.port}`, globalOpts);
        }

        // TODO: Phase 3 - Implement MCP server
        // 1. Set up MCP protocol handler
        // 2. Register tools (validate, convert, pod operations)
        // 3. Start transport (stdio or SSE)
        // 4. Handle tool invocations from AI agents

        printError('Server not yet implemented (Phase 3)', globalOpts);
        console.log(
          'The serve command will start a local MCP-compatible server ' +
            'that exposes Cascade Protocol tools to AI agents.',
        );
        console.log('');
        console.log('Planned transports:');
        console.log('  stdio  - Standard input/output (for direct integration)');
        console.log('  sse    - Server-Sent Events (for network access)');

        process.exitCode = 1;
      },
    );
}
