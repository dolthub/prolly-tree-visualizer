import { describe, expect, it } from 'vitest';
import { previewDiffValue } from './DiffValue';

describe('previewDiffValue', () => {
  it('keeps short values intact', () => {
    expect(previewDiffValue('value-42')).toEqual({ text: 'value-42' });
  });

  it('truncates growth values and reports their full length', () => {
    const value = `level-1280-${'x'.repeat(2048)}`;
    expect(previewDiffValue(value)).toEqual({
      text: `${value.slice(0, 36)}…`,
      characters: 2059,
    });
  });
});
