/**
 * MCP tool descriptors DERIVED from the registration itself.
 *
 * There used to be two hand-maintained lists of these tools — one in
 * `cascade capabilities`, one inside the `cascade_capabilities` MCP handler —
 * and they disagreed with each other and with the server. The CLI list
 * advertised `cascade_pod_import`, a tool that has never been registered
 * anywhere in `src/`, so an agent reading it would call a tool it could not
 * reach.
 *
 * There is now one source: `registerTools`. This module replays those
 * registrations against a recording stand-in for `McpServer` and reads the
 * zod schema each tool declares. Both documents call it. A tool the server
 * does not register cannot appear in either, and a tool it does register
 * cannot be missing from either.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** One parameter of an MCP tool, read off the tool's own zod schema. */
export interface McpParameterDescriptor {
  type: string;
  description: string;
  required: boolean;
  /** Allowed values, when the parameter is a zod enum. */
  enum?: string[];
  /** Field summaries, when the parameter is an object. */
  properties?: Record<string, string>;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, McpParameterDescriptor>;
  returns?: string;
  cliEquivalent?: string;
}

/**
 * Decoration for one MCP tool, keyed by tool name.
 *
 * As with command enrichment, this can only decorate a tool the server
 * registers: there is no `name` and no `parameters` field, so an entry here
 * cannot bring a tool into existence.
 */
export interface McpToolEnrichment {
  returns?: string;
  cliEquivalent?: string;
}

export type McpEnrichmentTable = Readonly<Record<string, McpToolEnrichment>>;

type ZodShape = Record<string, z.ZodType>;
type ToolRegistrar = (server: McpServer) => void;

/**
 * Describe every tool `register` registers, in registration order.
 *
 * `register` is invoked against a recorder, not a live server: registration
 * only stores names, descriptions, schemas and handlers, so nothing runs and
 * no handler is called.
 */
export function describeMcpTools(register: ToolRegistrar, enrichment: McpEnrichmentTable = {}): McpToolDescriptor[] {
  const descriptors: McpToolDescriptor[] = [];

  const recorder = {
    tool(...args: unknown[]): void {
      const [name, description, shape] = args;
      if (typeof name !== 'string') {
        throw new Error('An MCP tool was registered without a name; capabilities cannot describe it.');
      }
      // The 4-argument form (name, description, schema, handler) is the only one
      // in use. Anything else would silently lose the description or the
      // parameters from BOTH capabilities documents, so it fails here instead.
      if (typeof description !== 'string' || typeof shape !== 'object' || shape === null) {
        throw new Error(
          `MCP tool "${name}" is registered without a description and a parameter schema. ` +
            'Both capabilities documents are generated from that registration, so a tool ' +
            'registered in a shorter form would be advertised to agents with no usable ' +
            'description. Use server.tool(name, description, schema, handler).',
        );
      }
      descriptors.push(describeTool(name, description, shape as ZodShape, enrichment[name] ?? {}));
    },
  };

  register(recorder as unknown as McpServer);
  return descriptors;
}

/** The names `register` registers — the set both documents must advertise. */
export function registeredMcpToolNames(register: ToolRegistrar): string[] {
  return describeMcpTools(register).map((tool) => tool.name);
}

function describeTool(
  name: string,
  description: string,
  shape: ZodShape,
  extra: McpToolEnrichment,
): McpToolDescriptor {
  const parameters: Record<string, McpParameterDescriptor> = {};
  for (const [key, schema] of Object.entries(shape)) {
    parameters[key] = describeParameter(schema);
  }

  return {
    name,
    description,
    parameters,
    ...(extra.returns ? { returns: extra.returns } : {}),
    ...(extra.cliEquivalent ? { cliEquivalent: extra.cliEquivalent } : {}),
  };
}

function describeParameter(schema: z.ZodType): McpParameterDescriptor {
  const inner = unwrapOptional(schema);
  const choices = enumValues(inner);
  const properties = objectProperties(inner);

  return {
    type: zodTypeName(inner),
    description: schema.description ?? inner.description ?? '',
    required: !schema.isOptional(),
    ...(choices ? { enum: choices } : {}),
    ...(properties ? { properties } : {}),
  };
}

/** `.describe()` is often applied after `.optional()`, so both sides are read. */
function unwrapOptional(schema: z.ZodType): z.ZodType {
  return schema instanceof z.ZodOptional ? (schema.unwrap() as z.ZodType) : schema;
}

function zodTypeName(schema: z.ZodType): string {
  if (schema instanceof z.ZodString) return 'string';
  if (schema instanceof z.ZodNumber) return 'number';
  if (schema instanceof z.ZodBoolean) return 'boolean';
  if (schema instanceof z.ZodEnum) return 'string';
  if (schema instanceof z.ZodArray) return 'array';
  if (schema instanceof z.ZodObject) return 'object';
  if (schema instanceof z.ZodRecord) return 'object';
  return 'unknown';
}

function enumValues(schema: z.ZodType): string[] | undefined {
  if (!(schema instanceof z.ZodEnum)) return undefined;
  const options = (schema as unknown as { options: readonly unknown[] }).options;
  return options.map((value) => String(value));
}

/** One level of nesting is enough for the shapes these tools accept. */
function objectProperties(schema: z.ZodType): Record<string, string> | undefined {
  if (!(schema instanceof z.ZodObject)) return undefined;
  const shape = (schema as unknown as { shape: ZodShape }).shape;

  const properties: Record<string, string> = {};
  for (const [key, field] of Object.entries(shape)) {
    const inner = unwrapOptional(field);
    const optional = field.isOptional() ? ' (optional)' : '';
    const text = field.description ?? inner.description;
    properties[key] = `${zodTypeName(inner)}${optional}${text ? ` — ${text}` : ''}`;
  }
  return Object.keys(properties).length > 0 ? properties : undefined;
}
