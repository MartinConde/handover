import { UploadRefusedError } from './media.js';

/** Read dimensions from the encoded container, never from the browser's declaration. */
export function imageDimensions(
  bytes: Uint8Array,
  mime: string,
): { width: number; height: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number, n: number) => String.fromCharCode(...bytes.slice(at, at + n));
  let width = 0;
  let height = 0;
  try {
    if (mime === 'image/png' && text(0, 8) === '\x89PNG\r\n\x1a\n' && text(12, 4) === 'IHDR') {
      width = v.getUint32(16);
      height = v.getUint32(20);
    } else if (
      mime === 'image/gif' &&
      bytes.length >= 14 &&
      bytes.at(-1) === 0x3b &&
      ['GIF87a', 'GIF89a'].includes(text(0, 6))
    ) {
      width = v.getUint16(6, true);
      height = v.getUint16(8, true);
    } else if (mime === 'image/jpeg' && v.getUint16(0) === 0xffd8) {
      let at = 2;
      while (at + 4 <= bytes.length) {
        if (bytes[at++] !== 255) break;
        while (bytes[at] === 255) at++;
        const marker = bytes[at++];
        if (marker === undefined || marker === 0xda || marker === 0xd9) break;
        if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        const size = v.getUint16(at);
        if (size < 2 || at + size > bytes.length) break;
        if (
          [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
            marker,
          ) &&
          size >= 8
        ) {
          height = v.getUint16(at + 3);
          width = v.getUint16(at + 5);
          break;
        }
        at += size;
      }
    } else if (
      mime === 'image/webp' &&
      text(0, 4) === 'RIFF' &&
      text(8, 4) === 'WEBP' &&
      v.getUint32(4, true) + 8 === bytes.length
    ) {
      const kind = text(12, 4);
      const u24 = (at: number) =>
        v.getUint8(at) + v.getUint8(at + 1) * 256 + v.getUint8(at + 2) * 65536;
      if (kind === 'VP8X') {
        width = u24(24) + 1;
        height = u24(27) + 1;
      } else if (kind === 'VP8 ' && text(23, 3) === '\x9d\x01\x2a') {
        width = v.getUint16(26, true) & 0x3fff;
        height = v.getUint16(28, true) & 0x3fff;
      } else if (kind === 'VP8L' && bytes[20] === 0x2f) {
        const bits = v.getUint32(21, true);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      }
    } else if (mime === 'image/avif' && text(4, 4) === 'ftyp') {
      const end = v.getUint32(0);
      let avif = false;
      for (let at = 8; at + 4 <= Math.min(end, bytes.length); at += 4)
        if (at !== 12 && ['avif', 'avis'].includes(text(at, 4))) avif = true;
      const walk = (start: number, stop: number, depth: number) => {
        if (depth > 6) return;
        for (let at = start; at + 8 <= stop; ) {
          const size = v.getUint32(at);
          const kind = text(at + 4, 4);
          if (size < 8 || at + size > stop) return;
          if (kind === 'ispe' && size >= 20) {
            width = v.getUint32(at + 12);
            height = v.getUint32(at + 16);
            return;
          }
          if (['meta', 'iprp', 'ipco'].includes(kind))
            walk(at + (kind === 'meta' ? 12 : 8), at + size, depth + 1);
          if (width && height) return;
          at += size;
        }
      };
      if (avif) walk(end, bytes.length, 0);
    }
  } catch {
    /* A truncated header is a refused upload. */
  }
  if (!width || !height || width > 65535 || height > 65535)
    throw new UploadRefusedError(
      'The uploaded bytes are not a supported image of the declared type',
    );
  return { width, height };
}
