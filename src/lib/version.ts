/**
 * The one place the CLI's version is read.
 *
 * The MCP `cascade_capabilities` handler used to answer `version: '0.2.0'` from
 * a literal while the package was on 0.13.0. Any surface that states a version
 * imports it from here.
 */

import pkg from '../../package.json' with { type: 'json' };

export const CLI_VERSION: string = pkg.version;
export const CLI_PACKAGE_NAME: string = pkg.name;
