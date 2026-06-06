import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, isEncrypted, isSensitiveKey, SENSITIVE_KEYS } from '../../src/database/encryption';

describe('Encryption Module', () => {
  describe('isSensitiveKey', () => {
    it('should identify trakt.client_secret as sensitive', () => {
      expect(isSensitiveKey('trakt.client_secret')).toBe(true);
    });

    it('should identify trakt.access_token as sensitive', () => {
      expect(isSensitiveKey('trakt.access_token')).toBe(true);
    });

    it('should identify jdownloader.password as sensitive', () => {
      expect(isSensitiveKey('jdownloader.password')).toBe(true);
    });

    it('should identify jellyfin.api_key as sensitive', () => {
      expect(isSensitiveKey('jellyfin.api_key')).toBe(true);
    });

    it('should identify telegram.bot_token as sensitive', () => {
      expect(isSensitiveKey('telegram.bot_token')).toBe(true);
    });

    it('should not identify non-sensitive keys', () => {
      expect(isSensitiveKey('quality.minimum')).toBe(false);
      expect(isSensitiveKey('scheduler.interval_hours')).toBe(false);
    });
  });

  describe('isEncrypted', () => {
    it('should detect encrypted values (enc: prefix)', () => {
      expect(isEncrypted('enc:abc123')).toBe(true);
    });

    it('should return false for plain values', () => {
      expect(isEncrypted('plain-text')).toBe(false);
      expect(isEncrypted('')).toBe(false);
    });
  });

  describe('encrypt / decrypt round-trip', () => {
    it('should encrypt and decrypt back to original', () => {
      const original = 'my-secret-token-12345';
      const encrypted = encrypt(original);

      expect(encrypted).not.toBe(original);
      expect(isEncrypted(encrypted)).toBe(true);

      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(original);
    });

    it('should produce different ciphertexts for same plaintext (random IV)', () => {
      const original = 'same-input';
      const enc1 = encrypt(original);
      const enc2 = encrypt(original);

      expect(enc1).not.toBe(enc2); // Different IVs
      expect(decrypt(enc1)).toBe(original);
      expect(decrypt(enc2)).toBe(original);
    });

    it('should handle empty string', () => {
      expect(encrypt('')).toBe('');
      expect(decrypt('')).toBe('');
    });

    it('should handle unicode characters', () => {
      const original = 'Passwort mit Ümläuten: äöüß';
      const encrypted = encrypt(original);
      expect(decrypt(encrypted)).toBe(original);
    });

    it('should pass through non-encrypted values in decrypt', () => {
      expect(decrypt('plain-text')).toBe('plain-text');
    });
  });

  describe('SENSITIVE_KEYS set', () => {
    it('should contain expected built-in keys', () => {
      expect(SENSITIVE_KEYS.size).toBeGreaterThan(5);
      expect(SENSITIVE_KEYS.has('trakt.client_secret')).toBe(true);
      expect(SENSITIVE_KEYS.has('plex.token')).toBe(true);
      expect(SENSITIVE_KEYS.has('omdb.api_key')).toBe(true);
    });

    it('treats every secret-store.* key as sensitive via prefix rule', () => {
      // Plugin-requested shared secrets are sensitive by namespace, not by
      // enumeration in SENSITIVE_KEYS.
      expect(isSensitiveKey('secret-store.2captcha-api-key')).toBe(true);
      expect(isSensitiveKey('secret-store.anything')).toBe(true);
      expect(isSensitiveKey('plugins.demo.api_key')).toBe(false);
    });
  });
});
