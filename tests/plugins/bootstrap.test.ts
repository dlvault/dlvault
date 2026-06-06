import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/plugins/loader', () => ({
  loadPluginsFromDirectory: vi.fn(),
  defaultPluginsDir: vi.fn(() => '/default/plugins'),
}));

import { loadDynamicPlugins } from '../../src/plugins/bootstrap';
import { loadPluginsFromDirectory, defaultPluginsDir } from '../../src/plugins/loader';

describe('Plugin bootstrap — loadDynamicPlugins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to loadPluginsFromDirectory with the default dir', () => {
    const result = { loaded: ['a'], skipped: [], errors: [] };
    vi.mocked(loadPluginsFromDirectory).mockReturnValueOnce(result as any);

    expect(loadDynamicPlugins()).toBe(result);
    expect(defaultPluginsDir).toHaveBeenCalledTimes(1);
    expect(loadPluginsFromDirectory).toHaveBeenCalledWith('/default/plugins');
  });

  it('forwards an explicit directory and does not consult the default', () => {
    const result = { loaded: [], skipped: [], errors: [] };
    vi.mocked(loadPluginsFromDirectory).mockReturnValueOnce(result as any);

    expect(loadDynamicPlugins('/custom/dir')).toBe(result);
    expect(loadPluginsFromDirectory).toHaveBeenCalledWith('/custom/dir');
    expect(defaultPluginsDir).not.toHaveBeenCalled();
  });
});
