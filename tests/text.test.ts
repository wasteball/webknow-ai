import { describe, expect, it } from 'vitest';
import { fingerprint, normalizeText } from '../src/text';

describe('text identity', () => {
  it('normalizes layout whitespace without changing words', () => {
    expect(normalizeText('  原文\n  中间\t空格  ')).toBe('原文 中间 空格');
  });

  it('produces stable and content-sensitive fingerprints', () => {
    expect(fingerprint('同一段原文')).toBe(fingerprint('同一段原文'));
    expect(fingerprint('同一段原文')).not.toBe(fingerprint('不同原文'));
  });
});
