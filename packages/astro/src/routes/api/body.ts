export const MAX_JSON_BYTES = 1024 * 1024;

export class BodyTooLargeError extends Error {
  override name = 'BodyTooLargeError';
}

export class BodyStructureError extends Error {
  override name = 'BodyStructureError';
}

type ParsedBody = { text: string; json: unknown };
const parsedBodies = new WeakMap<Request, Promise<ParsedBody>>();

export async function readBodyText(request: Request): Promise<string> {
  return (await boundedBody(request, MAX_JSON_BYTES)).text;
}

export async function readJson(request: Request, limit = MAX_JSON_BYTES): Promise<unknown> {
  return (await boundedBody(request, limit)).json;
}

function boundedBody(request: Request, limit: number): Promise<ParsedBody> {
  if (limit !== MAX_JSON_BYTES) return parseBody(request, limit);
  const cached = parsedBodies.get(request);
  if (cached) return cached;
  const parsed = parseBody(request, limit);
  parsedBodies.set(request, parsed);
  return parsed;
}

async function parseBody(request: Request, limit: number): Promise<ParsedBody> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit)
    throw new BodyTooLargeError(`Request body exceeds ${limit} bytes`);
  const reader = request.body?.getReader();
  if (!reader) return { text: '', json: undefined };
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
    void reader.cancel().catch(() => undefined);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder().decode(data);
    const parsed = JSON.parse(text) as unknown;
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
    return { text, json: parsed };
  } catch (error) {
    if (error instanceof BodyStructureError) throw error;
    return { text: new TextDecoder().decode(data), json: undefined };
  }
}

export async function bodyErrorResponse(
  request?: Request,
  preserveBody = false,
): Promise<Response | undefined> {
  if (!request) return;
  try {
    await readJson(preserveBody ? request.clone() : request);
  } catch (error) {
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
