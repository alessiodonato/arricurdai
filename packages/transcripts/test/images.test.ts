import { describe, expect, test } from 'vitest';
import { imageSize, imagesTokens, imageTokens } from '../src/images';

// Only the headers matter: the parser never decodes a whole image.
const png = (width: number, height: number): string => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b.toString('base64');
};
const gif = (width: number, height: number): string => {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b.toString('base64');
};
const jpeg = (width: number, height: number): string => {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof0]).toString('base64');
};

describe('imageSize', () => {
  test('reads the size from PNG, GIF and JPEG headers', () => {
    expect(imageSize('image/png', png(1280, 720))).toEqual({ width: 1280, height: 720 });
    expect(imageSize('image/gif', gif(300, 200))).toEqual({ width: 300, height: 200 });
    expect(imageSize('image/jpeg', jpeg(1024, 768))).toEqual({ width: 1024, height: 768 });
  });

  test('gives up on headers it cannot read', () => {
    expect(imageSize('image/jpeg', Buffer.from('not a jpeg').toString('base64'))).toBeUndefined();
    expect(imageSize('image/bmp', png(10, 10))).toBeUndefined();
  });
});

describe('imageTokens', () => {
  test('is width × height / 750 for an image Claude does not scale', () => {
    // 1000 · 750 / 750
    expect(imageTokens('image/png', png(1000, 750))).toBe(1000);
  });

  test('scales large images down to at most 1568 pixels and 1.15 megapixels', () => {
    // 3000 × 2000 becomes 1568 × 1045, then shrinks to 1.15 megapixels: 1,150,000 / 750
    expect(imageTokens('image/png', png(3000, 2000))).toBe(1534);
  });

  test('assumes the largest size when the header cannot be read', () => {
    expect(imageTokens('image/webp', 'AAAA')).toBe(1534);
  });

  test('adds up the images of a content array and ignores the text', () => {
    const content = [
      { type: 'text', text: 'a screenshot' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(1000, 750) } },
      { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: gif(300, 250) } },
    ];
    // 1000 + 300 · 250 / 750
    expect(imagesTokens(content)).toBe(1100);
    expect(imagesTokens('just text')).toBe(0);
  });
});
