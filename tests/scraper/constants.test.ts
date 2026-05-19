import { describe, it, expect } from 'vitest';
import { QUALITY_RANK, AUDIO_RANK } from '../../src/scraper/constants';

describe('Generic Scraper Constants', () => {
  describe('QUALITY_RANK', () => {
    it('should rank 2160p highest', () => {
      expect(QUALITY_RANK['2160p']).toBe(4);
    });

    it('should rank 1080p > 720p > 480p', () => {
      expect(QUALITY_RANK['1080p']).toBeGreaterThan(QUALITY_RANK['720p']);
      expect(QUALITY_RANK['720p']).toBeGreaterThan(QUALITY_RANK['480p']);
    });

    it('should have all expected quality levels', () => {
      expect(Object.keys(QUALITY_RANK)).toEqual(expect.arrayContaining(['2160p', '1080p', '720p', '480p']));
    });
  });

  describe('AUDIO_RANK', () => {
    it('should rank 7.1 and atmos equally at highest', () => {
      expect(AUDIO_RANK['7.1']).toBe(AUDIO_RANK['atmos']);
      expect(AUDIO_RANK['7.1']).toBe(4);
    });

    it('should rank 5.1 and dts equally', () => {
      expect(AUDIO_RANK['5.1']).toBe(AUDIO_RANK['dts']);
    });

    it('should rank 5.1 > 2.0', () => {
      expect(AUDIO_RANK['5.1']).toBeGreaterThan(AUDIO_RANK['2.0']);
    });
  });
});
