import type { MediaType } from './types';

/**
 * Permissions a plugin can request. Each permission unlocks a host capability
 * on the PluginContext. Missing permission → context member is undefined.
 *
 * Surfaced in the install dialog ("This plugin needs: secrets") so
 * the user knows what they're authorizing.
 */
export type PluginPermission = 'secrets' | 'filesystem';

export interface PluginSettingField {
  key: string;
  label: string;
  /**
   * - `string`/`number`/`secret`: single-line input (secret = password-masked)
   * - `boolean`: toggle switch
   * - `multi-select`: a set of toggleable chips (e.g. hoster preference) —
   *   `options` declares the allowed values, the saved value is a
   *   comma-separated subset
   */
  type: 'string' | 'number' | 'boolean' | 'secret' | 'multi-select';
  /** Allowed values when type === 'multi-select'. Ignored for other types. */
  options?: string[];
  default?: string;
  description?: string;
}

/**
 * Manifest exported by every plugin. The host validates this on load and uses
 * it to render the install dialog, set up CSP, and namespace settings.
 *
 * Lives as a named export (`export const manifest`) alongside the default
 * factory export in the plugin's .dlvault.js bundle.
 */
export interface PluginManifest {
  /** Stable plugin id, kebab-case. Used in setting keys (plugins.<id>.*). */
  id: string;
  /** Human-readable name shown in the UI. */
  name: string;
  /** Semantic version of the plugin. */
  version: string;
  /** Media types this plugin can handle. */
  mediaTypes: MediaType[];
  /** Free-text description shown in the install dialog. */
  description?: string;
  /** Plugin author (name, optional email/url). */
  author?: string;
  /** Plugin homepage / source repo. */
  homepage?: string;
  /** Image-src domains the plugin needs in the host CSP (e.g. for posters). */
  cspDomains?: string[];
  /**
   * Minimum required host version (semver range, e.g. "^1.0.0").
   * Loader refuses to load plugins requiring newer host than what's running.
   */
  minHostVersion?: string;
  /** Host capabilities the plugin requests access to. */
  permissions?: PluginPermission[];
  /** Per-plugin user-facing settings — surfaced in the settings UI. */
  settingsSchema?: PluginSettingField[];
  /**
   * Shared secrets the plugin needs the user to configure. Read via
   * `context.secrets.get(key)` at runtime. Aggregated across all installed
   * plugins in the host's settings UI — if two plugins declare the same key,
   * the user fills it once and both see the same value. Use namespaced keys
   * (e.g. `"2captcha-api-key"`, `"tmdb-bearer-token"`) to avoid collisions
   * across unrelated plugins. Requires the `secrets` permission.
   */
  requiredSecrets?: RequiredSecret[];
}

export interface RequiredSecret {
  /**
   * Storage key, kebab-case, conventionally namespaced as
   * `<service>-<purpose>` (e.g. `"2captcha-api-key"`).
   */
  key: string;
  /** Human-readable label shown in the settings UI. */
  label: string;
  /** Optional explanation shown next to the input. */
  description?: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;
const VALID_PERMISSIONS = new Set<PluginPermission>(['secrets', 'filesystem']);
const SECRET_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const VALID_MEDIA_TYPES = new Set<MediaType>(['movie', 'show']);
const VALID_FIELD_TYPES = new Set(['string', 'number', 'boolean', 'secret', 'multi-select']);

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestValidationError';
  }
}

function requireField<T>(cond: T, msg: string): asserts cond {
  if (!cond) throw new ManifestValidationError(msg);
}

/**
 * Validate an unknown value as a PluginManifest. Throws ManifestValidationError
 * with a precise reason on failure. Pure function — no I/O.
 */
export function validateManifest(raw: unknown): PluginManifest {
  requireField(raw && typeof raw === 'object', 'manifest must be an object');
  const m = raw as Record<string, unknown>;

  requireField(typeof m.id === 'string', 'manifest.id must be a string');
  requireField(ID_PATTERN.test(m.id as string), `manifest.id "${m.id}" must be kebab-case (a-z, 0-9, -)`);

  requireField(typeof m.name === 'string' && (m.name as string).length > 0, 'manifest.name must be a non-empty string');

  requireField(typeof m.version === 'string', 'manifest.version must be a string');
  requireField(SEMVER_PATTERN.test(m.version as string), `manifest.version "${m.version}" must be semver (x.y.z)`);

  requireField(Array.isArray(m.mediaTypes) && (m.mediaTypes as unknown[]).length > 0,
    'manifest.mediaTypes must be a non-empty array');
  for (const t of m.mediaTypes as unknown[]) {
    requireField(typeof t === 'string' && VALID_MEDIA_TYPES.has(t as MediaType),
      `manifest.mediaTypes entry "${t}" must be "movie" or "show"`);
  }

  if (m.cspDomains !== undefined) {
    requireField(Array.isArray(m.cspDomains), 'manifest.cspDomains must be an array of strings');
    for (const d of m.cspDomains as unknown[]) {
      requireField(typeof d === 'string', 'manifest.cspDomains entries must be strings');
    }
  }

  if (m.minHostVersion !== undefined) {
    requireField(typeof m.minHostVersion === 'string', 'manifest.minHostVersion must be a string');
  }

  if (m.permissions !== undefined) {
    requireField(Array.isArray(m.permissions), 'manifest.permissions must be an array');
    for (const p of m.permissions as unknown[]) {
      requireField(typeof p === 'string' && VALID_PERMISSIONS.has(p as PluginPermission),
        `manifest.permissions entry "${p}" is not a known permission`);
    }
  }

  if (m.settingsSchema !== undefined) {
    requireField(Array.isArray(m.settingsSchema), 'manifest.settingsSchema must be an array');
    for (const f of m.settingsSchema as unknown[]) {
      requireField(f && typeof f === 'object', 'settingsSchema entries must be objects');
      const field = f as Record<string, unknown>;
      requireField(typeof field.key === 'string', 'settingsSchema field needs string "key"');
      requireField(typeof field.label === 'string', 'settingsSchema field needs string "label"');
      requireField(typeof field.type === 'string' && VALID_FIELD_TYPES.has(field.type as string),
        `settingsSchema field type "${field.type}" must be string|number|boolean|secret|multi-select`);
      if (field.type === 'multi-select') {
        requireField(Array.isArray(field.options) && (field.options as unknown[]).length > 0,
          `settingsSchema multi-select field "${field.key}" must declare a non-empty options array`);
        for (const opt of field.options as unknown[]) {
          requireField(typeof opt === 'string', `multi-select option in "${field.key}" must be a string`);
        }
      }
    }
  }

  if (m.requiredSecrets !== undefined) {
    requireField(Array.isArray(m.requiredSecrets), 'manifest.requiredSecrets must be an array');
    for (const s of m.requiredSecrets as unknown[]) {
      requireField(s && typeof s === 'object', 'requiredSecrets entries must be objects');
      const sec = s as Record<string, unknown>;
      requireField(typeof sec.key === 'string', 'requiredSecrets entry needs string "key"');
      requireField(SECRET_KEY_PATTERN.test(sec.key as string),
        `requiredSecrets key "${sec.key}" must be kebab-case (a-z, 0-9, -)`);
      requireField(typeof sec.label === 'string' && (sec.label as string).length > 0,
        `requiredSecrets entry for "${sec.key}" needs a non-empty label`);
      if (sec.description !== undefined) {
        requireField(typeof sec.description === 'string', `requiredSecrets description for "${sec.key}" must be a string`);
      }
    }
  }

  if (m.description !== undefined) requireField(typeof m.description === 'string', 'manifest.description must be a string');
  if (m.author !== undefined) requireField(typeof m.author === 'string', 'manifest.author must be a string');
  if (m.homepage !== undefined) requireField(typeof m.homepage === 'string', 'manifest.homepage must be a string');

  return m as unknown as PluginManifest;
}

/**
 * The running host version. Single source of truth is package.json so the
 * value used for plugin compatibility checks can never drift from the release.
 * Runtime require (not import) because package.json lives outside rootDir.
 */
export const HOST_VERSION: string = (require('../../package.json') as { version: string }).version;

/**
 * Tests whether a plugin's `minHostVersion` is satisfied by the running host.
 * Conservative: only supports "^x.y.z" and exact "x.y.z" — no full semver range
 * syntax. Returns true if the constraint is missing.
 */
export function hostVersionSatisfies(hostVersion: string, minHostVersion?: string): boolean {
  if (!minHostVersion) return true;
  const parse = (s: string) => s.replace(/^[~^]/, '').split('.').map(n => parseInt(n, 10));
  const host = parse(hostVersion);
  const want = parse(minHostVersion);
  if (host.some(isNaN) || want.some(isNaN)) return false;
  // Caret: same major, version >= want
  if (minHostVersion.startsWith('^')) {
    if (host[0] !== want[0]) return false;
    if (host[1] > want[1]) return true;
    if (host[1] < want[1]) return false;
    return host[2] >= want[2];
  }
  // Exact: major.minor.patch must match
  return host[0] === want[0] && host[1] === want[1] && host[2] === want[2];
}
