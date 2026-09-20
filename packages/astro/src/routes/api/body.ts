export const MAX_JSON_BYTES = 1024 * 1024;

export class BodyTooLargeError extends Error {
  override name = 'BodyTooLargeError';
}

export class BodyStructureError extends Error {
  override name = 'BodyStructureError';
}

export async function readJson(request: Request, limit = MAX_JSON_BYTES): Promise<unknown> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit)
    throw new BodyTooLargeError(`Request body exceeds ${limit} bytes`);
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new BodyTooLargeError(`Request body exceeds ${limit} bytes`);
      chunks.push(value);
    }
  } finally {
    // A cloned request is a tee: cancellation settles only after both branches close.
    // The original is still needed downstream, so never wait for that here.
    void reader.cancel().catch(() => undefined);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(data)) as unknown;
    const pending: { value: unknown; depth: number }[] = [{ value: parsed, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
      const { value, depth } = pending.pop() as { value: unknown; depth: number };
      if (!value || typeof value !== 'object') continue;
      if (depth >= 64) throw new BodyStructureError('Request JSON is nested too deeply');
      nodes += 1;
      if (nodes > 10_000) throw new BodyStructureError('Request JSON has too many values');
      for (const child of Array.isArray(value) ? value : Object.values(value))
        pending.push({ value: child, depth: depth + 1 });
    }
    return parsed;
  } catch (error) {
    if (error instanceof BodyStructureError) throw error;
    return undefined;
  }
}

export async function bodyErrorResponse(request?: Request): Promise<Response | undefined> {
  if (!request) return;
  try {
    await readJson(request.clone());
  } catch (error) {
    // Nothing downstream will consume a refused request. Cancel the other tee branch too.
    void request.body?.cancel().catch(() => undefined);
    if (error instanceof BodyTooLargeError)
      return Response.json({ code: 'BODY_TOO_LARGE', error: error.message }, { status: 413 });
    if (error instanceof BodyStructureError)
      return Response.json(
        { code: 'BODY_STRUCTURE_INVALID', error: error.message },
        { status: 400 },
      );
    throw error;
  }
}
