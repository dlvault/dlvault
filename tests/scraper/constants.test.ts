import { describe, it, expect } from 'vitest';
import { QUALITY_RANK, AUDIO_RANK, parseSizeToMB } from '../../src/scraper/constants';

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

  describe('parseSizeToMB', () => {
    it('parses GB/MB/TB/KB into megabytes', () => {
      expect(parseSizeToMB('1 GB')).toBe(1024);
      expect(parseSizeToMB('700 MB')).toBe(700);
      expect(parseSizeToMB('1 TB')).toBe(1024 * 1024);
      expect(parseSizeToMB('512 KB')).toBeCloseTo(0.5);
    });

    it('accepts both . and , as decimal separator and optional spacing', () => {
      expect(parseSizeToMB('21.9 GB')).toBeCloseTo(21.9 * 1024);
      expect(parseSizeToMB('1,5 TB')).toBeCloseTo(1.5 * 1024 * 1024);
      expect(parseSizeToMB('5GB')).toBe(5 * 1024);
    });

    it('handles thousands separators (de and en grouping)', () => {
      // German grouping: thousands-dot, decimal-comma
      expect(parseSizeToMB('1.234,5 GB')).toBeCloseTo(1234.5 * 1024);
      // English grouping: thousands-comma, decimal-dot
      expect(parseSizeToMB('1,234.5 GB')).toBeCloseTo(1234.5 * 1024);
      // Lone 3-digit group = thousands, not decimal
      expect(parseSizeToMB('1.234 GB')).toBeCloseTo(1234 * 1024);
    });

    it('is case-insensitive on the unit', () => {
      expect(parseSizeToMB('8 gb')).toBe(8 * 1024);
    });

    it('returns 0 for empty or unparseable input', () => {
      expect(parseSizeToMB('')).toBe(0);
      expect(parseSizeToMB('unknown')).toBe(0);
      expect(parseSizeToMB(undefined as unknown as string)).toBe(0);
    });

    it('orders real release sizes correctly', () => {
      expect(parseSizeToMB('25.2 GB')).toBeGreaterThan(parseSizeToMB('21.9 GB'));
      expect(parseSizeToMB('21.9 GB')).toBeGreaterThan(parseSizeToMB('13.6 GB'));
    });
  });
});
