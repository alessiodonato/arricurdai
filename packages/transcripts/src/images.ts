// Tokens of an image sent to Claude, from its pixel size: about width × height / 750, after Claude
// scales the image down so that its long side is at most 1568 pixels and its area at most 1.15
// megapixels. The size is read from the header of the base64 data, without decoding the whole image.

const MAX_SIDE = 1568;
const MAX_PIXELS = 1_150_000;
/** Used when the size cannot be read: the most an image can cost after scaling. */
const FALLBACK_TOKENS = Math.ceil(MAX_PIXELS / 750);

function header(data: string, bytes: number): Buffer {
  const chars = Math.ceil(bytes / 3) * 4;
  return Buffer.from(data.slice(0, chars), 'base64');
}

/** Width and height from the first bytes of a PNG, GIF, WebP or JPEG file. */
export function imageSize(mediaType: string, data: string): { width: number; height: number } | undefined {
  try {
    if (mediaType === 'image/png') {
      const b = header(data, 24);
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    if (mediaType === 'image/gif') {
      const b = header(data, 10);
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    }
    if (mediaType === 'image/webp') {
      const b = header(data, 30);
      const chunk = b.toString('ascii', 12, 16);
      if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const bits = b.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
      return undefined;
    }
    if (mediaType === 'image/jpeg') {
      // The size sits in the first start-of-frame marker, after the other markers of the header.
      const b = header(data, 65536);
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return undefined;
        const marker = b[i + 1]!;
        const length = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        }
        i += 2 + length;
      }
    }
  } catch {
    // A truncated or unusual header: fall back below.
  }
  return undefined;
}

/** Estimated tokens of one image block. */
export function imageTokens(mediaType: string, data: string): number {
  const size = imageSize(mediaType, data);
  if (!size || size.width === 0 || size.height === 0) return FALLBACK_TOKENS;
  let { width, height } = size;
  const sideScale = Math.min(1, MAX_SIDE / Math.max(width, height));
  width *= sideScale;
  height *= sideScale;
  const areaScale = Math.min(1, Math.sqrt(MAX_PIXELS / (width * height)));
  return Math.ceil((width * areaScale * height * areaScale) / 750);
}

/** Tokens of all the images in a content array, such as a tool result or a prompt. */
export function imagesTokens(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let tokens = 0;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const { type, source } = block as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } };
    if (type !== 'image') continue;
    if (source?.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
      tokens += imageTokens(source.media_type, source.data);
    } else {
      tokens += FALLBACK_TOKENS;
    }
  }
  return tokens;
}
