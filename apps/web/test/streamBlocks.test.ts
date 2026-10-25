import { describe, expect, it } from 'vitest';
import { splitBlocks } from '../src/lib/streamBlocks';

describe('splitBlocks', () => {
  it('splits paragraphs at blank lines', () => {
    expect(splitBlocks('one\n\ntwo\n\nthree')).toEqual(['one\n', 'two\n', 'three']);
  });

  it('keeps blank lines inside fenced code in one block', () => {
    const md = 'intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nafter';
    expect(splitBlocks(md)).toEqual(['intro\n', '```ts\nconst a = 1;\n\nconst b = 2;\n```\n', 'after']);
  });

  it('keeps an unterminated (still streaming) fence together', () => {
    expect(splitBlocks('```py\nx = 1\n\ny = 2')).toEqual(['```py\nx = 1\n\ny = 2']);
  });

  it('keeps indented continuations with their list item', () => {
    const md = '1. first\n\n   more about first\n\n2. second';
    expect(splitBlocks(md)).toEqual(['1. first\n\n   more about first\n', '2. second']);
  });

  it('only closes a fence with the same marker of at least the same length', () => {
    const md = '````\n```\ninner\n```\n````\n\nnext';
    expect(splitBlocks(md)).toEqual(['````\n```\ninner\n```\n````\n', 'next']);
  });

  it('round-trips the text', () => {
    const md = '# Title\n\npara\n\n- a\n- b\n\n```\ncode\n```\n\n> quote';
    expect(splitBlocks(md).join('\n')).toBe(md);
  });
});
