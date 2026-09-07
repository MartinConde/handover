import { ratioOf } from '@handover/core';
import { type MediaItem, uploadBlob } from './upload.js';

/** A rectangle of the original, in its own pixels: what a crop is before it is any bytes. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Below this a crop is a mistake rather than a picture, however small the handle is dragged. */
const MIN = 16;
const clamp = (n: number, low: number, high: number) =>
  Math.min(Math.max(n, low), Math.max(low, high));

/** The widest crop at this ratio the picture holds, in the middle of it. */
export function fitRegion(width: number, height: number, ratio?: string): Region {
  const r = ratioOf(ratio);
  const w = r ? Math.min(width, Math.round(height * r)) : width;
  const h = r ? Math.round(w / r) : height;
  return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h };
}

/** Dragged or nudged, and never off the picture: a crop is a rectangle of one photograph. */
export function moveRegion(
  region: Region,
  width: number,
  height: number,
  dx: number,
  dy: number,
): Region {
  return {
    ...region,
    x: Math.round(clamp(region.x + dx, 0, width - region.w)),
    y: Math.round(clamp(region.y + dy, 0, height - region.h)),
  };
}

/** The crop at a size somebody typed on a slider, grown or shrunk about its own middle. */
export function sizeRegion(
  region: Region,
  width: number,
  height: number,
  w: number,
  h: number,
  ratio?: string,
): Region {
  const r = ratioOf(ratio);
  let nw = clamp(Math.round(w), MIN, width);
  let nh = r ? Math.round(nw / r) : clamp(Math.round(h), MIN, height);
  if (nh > height) {
    nh = height;
    if (r) nw = Math.round(nh * r);
  }
  const x = Math.round(region.x + region.w / 2 - nw / 2);
  const y = Math.round(region.y + region.h / 2 - nh / 2);
  return moveRegion({ x, y, w: nw, h: nh }, width, height, 0, 0);
}

/** A corner dragged to a point, with the corner opposite held where it is. */
export function dragRegion(
  region: Region,
  width: number,
  height: number,
  corner: 'nw' | 'ne' | 'sw' | 'se',
  px: number,
  py: number,
  ratio?: string,
): Region {
  const left = corner.endsWith('w');
  const top = corner.startsWith('n');
  // The held corner, and how much picture there is between it and the edge the drag is going to.
  const ax = left ? region.x + region.w : region.x;
  const ay = top ? region.y + region.h : region.y;
  const roomW = left ? ax : width - ax;
  const roomH = top ? ay : height - ay;
  const r = ratioOf(ratio);
  let w = clamp(Math.abs(clamp(px, 0, width) - ax), MIN, roomW);
  let h = r ? Math.round(w / r) : clamp(Math.abs(clamp(py, 0, height) - ay), MIN, roomH);
  if (h > roomH) {
    h = roomH;
    if (r) w = Math.round(h * r);
  }
  return { x: left ? ax - w : ax, y: top ? ay - h : ay, w, h };
}

/** What the copy is called: the picture's own name, said to be a crop of it. */
export const cropName = (filename?: string | null) =>
  `${(filename ?? '').replace(/\.[^.]+$/, '') || 'crop'}${filename ? '-crop' : ''}.webp`;

/** The crop as its own asset: the original's bytes are read back from the bucket. */
export async function uploadCrop(
  item: MediaItem,
  region: Region,
  deps: { fetch?: typeof globalThis.fetch } = {},
): Promise<MediaItem> {
  const { fetch = globalThis.fetch } = deps;
  // CORS must permit reading the stored original.
  const res = await fetch(item.url ?? '', { cache: 'reload' }).catch(() => undefined);
  if (!res?.ok)
    throw new Error(
      'the original could not be read back from storage — the bucket needs GET in its CORS rule for this site',
    );
  const source = await createImageBitmap(await res.blob());
  const canvas = document.createElement('canvas');
  canvas.width = region.w;
  canvas.height = region.h;
  canvas
    .getContext('2d')
    ?.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
  source.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', 0.9),
  );
  if (!blob) throw new Error('the crop could not be made');
  return uploadBlob(
    blob,
    {
      filename: cropName(item.filename),
      width: region.w,
      height: region.h,
      derivedFrom: item.id,
    },
    { fetch },
  );
}
