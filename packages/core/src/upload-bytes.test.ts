import { expect, test } from 'vitest';
import { imageDimensions } from './upload-bytes.js';

// Actual 3 × 2 encoded images (including lossy and lossless WebP), generated with libvips.
const samples = [
  {
    mime: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWMQCVgFQQxwFgA72AZVtrkmWQAAAABJRU5ErkJggg==',
  },
  {
    mime: 'image/jpeg',
    data: '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAMDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJoAfir/2Q==',
  },
  {
    mime: 'image/gif',
    data: 'R0lGODlhAwACAIAAAExpcRRQqiH5BAUAAAAALAAAAAADAAIAAAICjF8AOw==',
  },
  {
    mime: 'image/webp',
    data: 'UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoDAAIAAUAmJaACdLoB+AADsAD+9IiH/pNnibPE2fJI/+Uq8Fjc3wAA',
  },
  {
    mime: 'image/avif',
    data: 'AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAACUAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAAMAAAACAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAtbWRhdBIACgg4BCtICGg0gDIXGUJjBMAANAAAkEDJHGFDnamzRWNW0IA=',
  },
  {
    mime: 'image/webp',
    data: 'UklGRh4AAABXRUJQVlA4TBEAAAAvAkAAEAdQqFJUtYCBiOh/AAA=',
  },
];
test.each(samples)('reads dimensions from a real $mime container', ({ mime, data }) => {
  const bytes = Buffer.from(data, 'base64');
  expect(imageDimensions(bytes, mime)).toEqual({ width: 3, height: 2 });
  expect(() => imageDimensions(bytes.subarray(0, 12), mime)).toThrow();
  expect(() => imageDimensions(Buffer.from('<html>not an image</html>'), mime)).toThrow();
});
