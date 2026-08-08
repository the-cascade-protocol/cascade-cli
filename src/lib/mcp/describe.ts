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
  const chain = unwrapChain(schema);
  const core = chain[chain.length - 1];
  const choices = enumValues(core);
  const properties = objectProperties(core);

  return {
    type: zodTypeName(core),
    // `.describe()` may be applied at any point in the chain.
    description: chain.find((link) => link.description !== undefined)?.description ?? '',
    required: !schema.isOptional(),
    ...(choices ? { enum: choices } : {}),
    ...(properties ? { properties } : {}),
  };
}

/**
 * Peel the wrappers off a schema, outermost first, down to the type that
 * carries the shape and the allowed values.
 *
 * This has to keep going rather than unwrap once. `z.enum([...]).default('x')`
 * is a wrapper around an enum, and stopping at the wrapper reports the
 * parameter as type `unknown` with no enum at all — silently deleting the only
 * list of valid values an agent has, while every test stays green. Swapping
 * `.optional()` for `.default()` is a routine, more-correct cleanup, so this is
 * a live hazard rather than a hypothetical one.
 *
 * Wrappers this does not know about are not silently tolerated either: they
 * surface as type `unknown`, which `tests/capabilities-registry.test.ts` fails
 * on. That gate is the general protection; these three unwraps are the cases
 * that exist today.
 */
function unwrapChain(schema: z.ZodType): z.ZodType[] {
  const chain: z.ZodType[] = [schema];
  let current = schema;

  // Bounded: a wrapper chain this long is a bug, not a schema.
  for (let depth = 0; depth < 10; depth += 1) {
    const next = unwrapOnce(current);
    if (!next) break;
    chain.push(next);
    current = next;
  }
  return chain;
}

function unwrapOnce(schema: z.ZodType): z.ZodType | undefined {
  if (schema instanceof z.ZodOptional) return schema.unwrap() as z.ZodType;
  if (schema instanceof z.ZodNullable) return schema.unwrap() as z.ZodType;
  if (schema instanceof z.ZodDefault) return schema.unwrap() as z.ZodType;
  return undefined;
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
    const chain = unwrapChain(field);
    const core = chain[chain.length - 1];
    const optional = field.isOptional() ? ' (optional)' : '';
    const text = chain.find((link) => link.description !== undefined)?.description;
    properties[key] = `${zodTypeName(core)}${optional}${text ? ` — ${text}` : ''}`;
  }
  return Object.keys(properties).length > 0 ? properties : undefined;
}
