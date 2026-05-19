import { describe, it, expect } from 'vitest';
import { validateManifest, hostVersionSatisfies, pluginApiVersionSatisfies, ManifestValidationError, PLUGIN_API_VERSION } from '../../src/plugins/manifest';

const minimal = {
  id: 'demo-plugin',
  name: 'Demo Plugin',
  version: '1.0.0',
  mediaTypes: ['movie'],
};

describe('validateManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const m = validateManifest(minimal);
    expect(m.id).toBe('demo-plugin');
    expect(m.mediaTypes).toEqual(['movie']);
  });

  it('accepts all optional fields', () => {
    const m = validateManifest({
      ...minimal,
      description: 'Demo',
      author: 'dlvault',
      homepage: 'https://example.com',
      cspDomains: ['example.com', 'cdn.example.com'],
      permissions: ['filesystem', 'secrets'],
      minHostVersion: '^1.0.0',
      settingsSchema: [
        { key: 'api_key', label: 'API key', type: 'secret' },
        { key: 'limit', label: 'Limit', type: 'number', default: '10' },
      ],
      requiredSecrets: [
        { key: 'example-api-key', label: 'Example API key', description: 'for testing' },
      ],
    });
    expect(m.permissions).toEqual(['filesystem', 'secrets']);
    expect(m.settingsSchema).toHaveLength(2);
    expect(m.requiredSecrets).toHaveLength(1);
    expect(m.requiredSecrets![0].key).toBe('example-api-key');
  });

  it('rejects non-object input', () => {
    expect(() => validateManifest(null)).toThrow(ManifestValidationError);
    expect(() => validateManifest('hi')).toThrow(/manifest must be an object/);
  });

  it('rejects an invalid id (non-kebab)', () => {
    expect(() => validateManifest({ ...minimal, id: 'Demo_Plugin' })).toThrow(/kebab-case/);
  });

  it('rejects a non-semver version', () => {
    expect(() => validateManifest({ ...minimal, version: 'v1' })).toThrow(/semver/);
  });

  it('rejects empty mediaTypes', () => {
    expect(() => validateManifest({ ...minimal, mediaTypes: [] })).toThrow(/non-empty array/);
  });

  it('rejects an unknown mediaType', () => {
    expect(() => validateManifest({ ...minimal, mediaTypes: ['music'] })).toThrow(/movie.*show/);
  });

  it('rejects an unknown permission', () => {
    expect(() => validateManifest({ ...minimal, permissions: ['network'] })).toThrow(/not a known permission/);
  });

  it('rejects malformed settings fields', () => {
    expect(() => validateManifest({ ...minimal, settingsSchema: [{ key: 'a', label: 'A', type: 'date' }] }))
      .toThrow(/string\|number\|boolean\|secret/);
  });

  it('accepts an integer apiVersion', () => {
    const m = validateManifest({ ...minimal, apiVersion: 1 });
    expect(m.apiVersion).toBe(1);
  });

  it('rejects a non-integer or non-positive apiVersion', () => {
    expect(() => validateManifest({ ...minimal, apiVersion: 1.5 })).toThrow(/positive integer/);
    expect(() => validateManifest({ ...minimal, apiVersion: 0 })).toThrow(/positive integer/);
    expect(() => validateManifest({ ...minimal, apiVersion: '1' })).toThrow(/positive integer/);
  });
});

describe('pluginApiVersionSatisfies', () => {
  it('accepts a plugin without apiVersion (defaults to v1)', () => {
    expect(pluginApiVersionSatisfies(PLUGIN_API_VERSION, undefined)).toBe(true);
  });

  it('accepts a plugin targeting the current API version', () => {
    expect(pluginApiVersionSatisfies(2, 2)).toBe(true);
  });

  it('accepts a plugin targeting an older API version', () => {
    expect(pluginApiVersionSatisfies(3, 1)).toBe(true);
  });

  it('refuses a plugin targeting a newer API version than the host', () => {
    expect(pluginApiVersionSatisfies(1, 2)).toBe(false);
  });
});

describe('hostVersionSatisfies', () => {
  it('passes when no requirement is set', () => {
    expect(hostVersionSatisfies('1.0.0', undefined)).toBe(true);
  });

  it('passes for exact match', () => {
    expect(hostVersionSatisfies('1.2.3', '1.2.3')).toBe(true);
    expect(hostVersionSatisfies('1.2.3', '1.2.4')).toBe(false);
  });

  it('handles caret ranges within same major', () => {
    expect(hostVersionSatisfies('1.5.0', '^1.2.0')).toBe(true);
    expect(hostVersionSatisfies('1.2.0', '^1.2.0')).toBe(true);
    expect(hostVersionSatisfies('1.1.0', '^1.2.0')).toBe(false);
    expect(hostVersionSatisfies('2.0.0', '^1.2.0')).toBe(false);
  });
});
