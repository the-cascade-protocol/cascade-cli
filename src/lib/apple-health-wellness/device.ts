/**
 * Apple's `device` attribute, made safe to name things by.
 *
 * Apple prints the device as one string:
 *
 *   <<HKDevice: 0x78a564f00>, name:Apple Watch, manufacturer:Apple Inc.,
 *     model:Watch, hardware:Watch3,3, software:6.1.1, creation date:...>
 *
 * MEASURED (two real exports three months apart): the `0x...` memory address
 * changes on EVERY export and is the only volatile attribute in the file. With
 * it stripped, 74,933 of 74,933 closed-day buckets digest identically across
 * the two exports; with it kept, 55,266 of them differ. And `manufacturer:`
 * reads "Apple" under older software and "Apple Inc." under newer, so it is
 * never part of a device's identity. A device is identified by its normalized
 * name plus its hardware model, and nothing else.
 */

import { wellnessDeviceIdentity } from '../identity.js';

const ADDRESS_RE = /(<<HKDevice:\s*)0x[0-9a-fA-F]+>/;

/** Remove the per-export memory address from a raw device string. Everything else is kept byte-for-byte. */
export function stripDeviceAddress(raw: string): string {
  return raw.replace(ADDRESS_RE, '$1>');
}

export interface AppleDevice {
  name?: string;
  manufacturer?: string;
  model?: string;
  hardware?: string;
  software?: string;
}

const KEYS = ['name', 'manufacturer', 'model', 'hardware', 'software', 'localIdentifier', 'FDA UDI', 'creation date'];
const FIELD_SPLIT = new RegExp(`,\\s*(?=(?:${KEYS.map((k) => k.replace(' ', '\\s')).join('|')}):)`);

/**
 * Parse a device string into its fields. Values may themselves contain commas
 * (`hardware:Watch3,3`), so fields are split only where a known key follows.
 * Undefined when the string is not an HKDevice rendering at all.
 */
export function parseAppleDevice(raw: string | undefined): AppleDevice | undefined {
  if (!raw) return undefined;
  const s = stripDeviceAddress(raw).trim();
  const m = /^<<HKDevice:\s*>\s*,?\s*([\s\S]*?)>?$/.exec(s);
  if (!m) return undefined;
  const out: AppleDevice = {};
  for (const field of m[1].split(FIELD_SPLIT)) {
    const colon = field.indexOf(':');
    if (colon <= 0) continue;
    const key = field.slice(0, colon).trim();
    const value = field.slice(colon + 1).trim();
    if (!value) continue;
    if (key === 'name') out.name = value;
    else if (key === 'manufacturer') out.manufacturer = value;
    else if (key === 'model') out.model = value;
    else if (key === 'hardware') out.hardware = value;
    else if (key === 'software') out.software = value;
  }
  return out;
}

/**
 * Normalize a device or source name for identity: Unicode NFC, curly
 * apostrophes to the straight one (one real export spells one owner's devices
 * both ways), internal whitespace collapsed, ends trimmed.
 */
export function normalizeName(name: string): string {
  return name.normalize('NFC').replace(/[\u2018\u2019\u02BC]/g, "'").replace(/\s+/g, ' ').trim();
}

export interface DeviceIdentity {
  identity: string;
  name: string;
  device: AppleDevice;
}

// A real export repeats a few hundred distinct device strings across millions
// of samples, so each is parsed once.
const identityCache = new Map<string, DeviceIdentity | null>();

/** A device's identity key and the fields it is described by, or undefined when it names no device. */
export function deviceIdentityOf(raw: string | undefined): DeviceIdentity | undefined {
  if (!raw) return undefined;
  const hit = identityCache.get(raw);
  if (hit !== undefined) return hit ?? undefined;
  let out: DeviceIdentity | null = null;
  const device = parseAppleDevice(raw);
  const name = device?.name ? normalizeName(device.name) : '';
  if (device && name) out = { identity: wellnessDeviceIdentity(name, device.hardware), name, device };
  if (identityCache.size > 10_000) identityCache.clear();
  identityCache.set(raw, out);
  return out ?? undefined;
}
