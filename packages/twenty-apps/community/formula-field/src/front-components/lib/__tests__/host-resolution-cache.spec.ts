import { afterEach, describe, expect, it } from 'vitest';

import {
  __clearHostResolutionCacheForTests,
  cacheHostObject,
  getCachedHostObject,
} from 'src/front-components/lib/host-resolution-cache';

afterEach(() => __clearHostResolutionCacheForTests());

describe('host-resolution-cache', () => {
  it('returns null for an unknown record id', () => {
    expect(getCachedHostObject('rec-1')).toBeNull();
  });

  it('returns the cached object after a write', () => {
    cacheHostObject('rec-1', 'company');
    expect(getCachedHostObject('rec-1')).toBe('company');
  });
});
