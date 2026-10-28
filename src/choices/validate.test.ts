import { describe, it, expect } from 'vitest';
import { applyChoices, choiceCommandsSchema, choicesSchema, isTelegramChannel } from './validate.js';

describe('choicesSchema', () => {
  it('accepts 1 to 8 labels of up to 64 characters', () => {
    expect(choicesSchema.safeParse(['A']).success).toBe(true);
    expect(choicesSchema.safeParse(Array.from({ length: 8 }, (_, i) => `L${i}`)).success).toBe(true);
    expect(choicesSchema.safeParse(['x'.repeat(64)]).success).toBe(true);
  });

  it('rejects 0 labels, 9 labels, empty/blank labels, and labels over 64 characters', () => {
    expect(choicesSchema.safeParse([]).success).toBe(false);
    expect(choicesSchema.safeParse(Array.from({ length: 9 }, (_, i) => `L${i}`)).success).toBe(false);
    expect(choicesSchema.safeParse(['A', '']).success).toBe(false);
    expect(choicesSchema.safeParse(['  ']).success).toBe(false);
    expect(choicesSchema.safeParse(['x'.repeat(65)]).success).toBe(false);
  });
});

describe('applyChoices', () => {
  it('puts choices in metadata for telegram channels, leaving the body alone', () => {
    for (const ch of ['telegram', 'telegram:peggy', 'telegram:peggy:group:-100123']) {
      expect(isTelegramChannel(ch)).toBe(true);
      expect(applyChoices(ch, 'Pick', { a: 1 }, ['A', 'B'])).toEqual({ body: 'Pick', metadata: { a: 1, choices: ['A', 'B'] } });
    }
  });

  it('appends a numbered list for other channels and adds no metadata', () => {
    expect(isTelegramChannel('email')).toBe(false);
    expect(applyChoices('email', 'Pick', {}, ['A', 'B'])).toEqual({ body: 'Pick\n\n1. A\n2. B', metadata: {} });
  });

  it('is a no-op without choices', () => {
    expect(applyChoices('telegram', 'Pick', { a: 1 }, undefined)).toEqual({ body: 'Pick', metadata: { a: 1 } });
  });
});

describe('choiceCommandsSchema (E54)', () => {
  it('accepts single-line slash commands and nulls, up to 8 entries', () => {
    expect(choiceCommandsSchema.safeParse(['/model claude-opus-5-5', null]).success).toBe(true);
    expect(choiceCommandsSchema.safeParse(Array.from({ length: 8 }, () => '/model x')).success).toBe(true);
  });

  it('rejects non-slash text, multi-line commands, over-long commands and more than 8 entries', () => {
    expect(choiceCommandsSchema.safeParse(['model x']).success).toBe(false);
    expect(choiceCommandsSchema.safeParse(['/']).success).toBe(false);
    expect(choiceCommandsSchema.safeParse(['/model x\n/model y']).success).toBe(false);
    expect(choiceCommandsSchema.safeParse([`/${'x'.repeat(200)}`]).success).toBe(false);
    expect(choiceCommandsSchema.safeParse(Array.from({ length: 9 }, () => null)).success).toBe(false);
  });
});
