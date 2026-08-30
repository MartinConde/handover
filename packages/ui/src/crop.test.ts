import { expect, test } from 'vitest';
import { cropName, dragRegion, fitRegion, moveRegion, sizeRegion } from './crop.js';

// 2400 × 1600 is the demo's own photograph; every number below is worked out on it by hand.
const W = 2400;
const H = 1600;

test('a locked crop opens as the widest one the picture holds, centred', () => {
  // 16:9 of a 3:2 picture is limited by the width: 2400 wide, 1350 tall, 125 px of margin.
  expect(fitRegion(W, H, '16:9')).toEqual({ x: 0, y: 125, w: 2400, h: 1350 });
  // 1:1 is limited by the height instead, and the margin moves to the sides.
  expect(fitRegion(W, H, '1:1')).toEqual({ x: 400, y: 0, w: 1600, h: 1600 });
  // Free starts as the whole picture: cropping nothing is a copy, and the client can see that.
  expect(fitRegion(W, H)).toEqual({ x: 0, y: 0, w: 2400, h: 1600 });
});

test('a crop cannot be pushed off the edge of the picture', () => {
  const box = fitRegion(W, H, '1:1');
  expect(moveRegion(box, W, H, 100, 50)).toEqual({ x: 500, y: 0, w: 1600, h: 1600 });
  // Both ends: the left edge stops at 0 and the right at the width of the picture.
  expect(moveRegion(box, W, H, -9999, 0)).toEqual({ x: 0, y: 0, w: 1600, h: 1600 });
  expect(moveRegion(box, W, H, 9999, 9999)).toEqual({ x: 800, y: 0, w: 1600, h: 1600 });
});

test('a size typed on a slider holds the ratio and the centre, and stops at the picture', () => {
  const box = fitRegion(W, H, '16:9');
  // 200 px narrower, and the height follows the ratio: 2200 × 1238, still centred.
  expect(sizeRegion(box, W, H, 2200, box.h, '16:9')).toEqual({ x: 100, y: 181, w: 2200, h: 1238 });
  // Bigger than the picture is not a crop of it: the widest 16:9 is where it stops.
  expect(sizeRegion(box, W, H, 9999, box.h, '16:9')).toEqual({ x: 0, y: 125, w: 2400, h: 1350 });
  // Free takes both numbers as they are typed, and each stops at the picture's own side.
  expect(sizeRegion({ x: 100, y: 100, w: 400, h: 300 }, W, H, 500, 400)).toEqual({
    x: 50,
    y: 50,
    w: 500,
    h: 400,
  });
});

test('a dragged corner holds the one opposite it', () => {
  const box = { x: 400, y: 200, w: 1000, h: 800 };
  // The top-left is dragged to 600 × 400; the bottom-right, at 1400 × 1000, stays where it is.
  expect(dragRegion(box, W, H, 'nw', 600, 400)).toEqual({ x: 600, y: 400, w: 800, h: 600 });
  // Locked to 1:1, the pointer names the width and the height follows it.
  expect(dragRegion(box, W, H, 'se', 900, 1500, '1:1')).toEqual({
    x: 400,
    y: 200,
    w: 500,
    h: 500,
  });
  // Dragged past the far corner, and past the edge of the picture with it.
  expect(dragRegion(box, W, H, 'se', 9999, 9999)).toEqual({ x: 400, y: 200, w: 2000, h: 1400 });
});

test('the copy is named after the picture it was cropped out of', () => {
  expect(cropName('front-of-house.jpg')).toBe('front-of-house-crop.webp');
  expect(cropName('front-of-house-crop.webp')).toBe('front-of-house-crop-crop.webp');
  expect(cropName(undefined)).toBe('crop.webp');
});
