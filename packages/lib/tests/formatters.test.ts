import { describe, expect, it } from 'vitest';
import { formatUserInitials } from '../src/formatters';

describe('user initials', () => {
  it('uses the first and last word', () => {
    expect(formatUserInitials('Ada Lovelace')).toBe('AL');
  });

  it('keeps a single word to one initial', () => {
    expect(formatUserInitials('Ada')).toBe('A');
  });

  it('ignores repeated and surrounding whitespace', () => {
    expect(formatUserInitials('  ada   lovelace  ')).toBe('AL');
  });

  it('returns nothing for a blank name instead of throwing', () => {
    expect(formatUserInitials('')).toBe('');
    expect(formatUserInitials('   ')).toBe('');
  });
});
