import { describe, expect, it } from 'vitest';
import { parseTunnelHost } from '../src/config.js';

describe('explicit tunnel host configuration', () => {
  it('accepts only exact hostnames, never wildcard or URL input', () => {
    expect(parseTunnelHost(undefined)).toBeUndefined();
    expect(parseTunnelHost(' Demo.Example.com ')).toBe('demo.example.com');
    for (const value of ['*.example.com', 'https://demo.example.com', 'demo.example.com:443', 'demo.example.com/path', 'demo.example.com,other.example.com', 'demo.example.com\nattacker.example.com']) {
      expect(() => parseTunnelHost(value)).toThrow(/exact hostname/);
    }
  });
});
