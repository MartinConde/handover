import {
  CommitScopeError,
  DraftConflictError,
  DraftRevisionError,
  isDraftRace,
  isMediaRace,
  MediaInUseError,
  MediaUnavailableError,
  OperationFinalizationError,
  RefMovedError,
  RenameCollisionError,
  RepoUnreachableError,
  ResourceLimitError,
  RevertConflictError,
  UploadRefusedError,
} from '@handover/core';

// The header carries the code too, so a client can branch on it without parsing the body.
export const codedError = (
  status: number,
  code: string,
  error: string,
  more: Record<string, unknown> = {},
) =>
  Response.json({ code, error, ...more }, { status, headers: { 'x-handover-error-code': code } });

// Every route answers the same way when git refuses, whether it was reading or committing.
type AnswerCodes = Partial<{
  conflict: string;
  finalization: string;
  refMoved: string;
  repository: string;
}>;

export async function answering(
  work: () => Promise<Response>,
  codes: AnswerCodes = {},
): Promise<Response> {
  try {
    return await work();
  } catch (err) {
    // The repository is out of reach for every path, so 503 with the message rather than a 404.
    if (err instanceof RepoUnreachableError)
      return codes.repository
        ? codedError(503, codes.repository, err.message)
        : new Response(err.message, { status: 503 });
    // A conflict names its files as data so the drawer can badge those rows.
    if (err instanceof DraftConflictError)
      return codes.conflict
        ? codedError(409, codes.conflict, err.message, { paths: err.paths })
        : Response.json({ error: err.message, paths: err.paths }, { status: 409 });
    if (err instanceof CommitScopeError) return new Response(err.message, { status: 403 });
    if (err instanceof DraftRevisionError || isDraftRace(err))
      return Response.json(
        { error: new DraftRevisionError().message, reason: 'revision' },
        { status: 409 },
      );
    if (err instanceof MediaInUseError || err instanceof MediaUnavailableError || isMediaRace(err))
      return codedError(
        409,
        err instanceof MediaInUseError ? 'MEDIA_BECAME_USED' : 'MEDIA_UNAVAILABLE',
        err instanceof Error ? err.message : new MediaUnavailableError().message,
        { reason: 'media' },
      );
    // A refused revert names its files the way a publish's conflict does.
    if (err instanceof RevertConflictError)
      return codedError(409, 'REVERT_CONFLICT', err.message, { paths: err.paths });
    if (err instanceof RenameCollisionError)
      return codedError(409, 'ENTRY_RENAME_COLLISION', err.message);
    if (err instanceof RefMovedError)
      return codes.refMoved
        ? codedError(409, codes.refMoved, err.message)
        : new Response(err.message, { status: 409 });
    if (err instanceof OperationFinalizationError) {
      const finalizing = {
        reason: 'needs-finalization',
        operation_id: err.operationId,
        commit_sha: err.commitSha,
      };
      return codes.finalization
        ? codedError(503, codes.finalization, err.message, finalizing)
        : Response.json({ error: err.message, ...finalizing }, { status: 503 });
    }
    // A refused upload is the chooser's own file, so it is answered to them by the rule it broke.
    if (err instanceof UploadRefusedError)
      return err.code
        ? codedError(422, err.code, err.message, { limit: err.limit })
        : Response.json({ error: err.message }, { status: 422 });
    if (err instanceof ResourceLimitError) return codedError(429, 'RESOURCE_LIMIT', err.message);
    throw err;
  }
}

export const entryNotFound = () =>
  new Response('Not found', {
    status: 404,
    headers: { 'x-handover-error-code': 'ENTRY_NOT_FOUND' },
  });

export const notFound = () => new Response('Not found', { status: 404 });

type Session = App.Locals['handover'];

/** Owner-only routes assert it here rather than trusting the sidebar to hide them. */
export const isOwner = (session: Session): session is NonNullable<Session> =>
  session?.role === 'owner';

export const forbidden = () => new Response('Forbidden', { status: 403 });
