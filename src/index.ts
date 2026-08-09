#!/usr/bin/env node

/**
 * @the-cascade-protocol/cli
 *
 * Cascade Protocol CLI - Validate, convert, and manage health data.
 *
 * Usage:
 *   cascade <command> [options]
 *
 * The command tree is assembled by `buildProgram()` in `program.ts`, which is
 * also what `cascade capabilities` describes. Run `cascade capabilities` for
 * the full machine-readable command reference.
 */

import { buildProgram } from './program.js';

buildProgram().parse();
