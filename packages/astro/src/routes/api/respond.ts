// The header carries the code too, so a client can branch on it without parsing the body.
export const codedError = (
  status: number,
  code: string,
  error: string,
  more: Record<string, unknown> = {},
) =>
  Response.json({ code, error, ...more }, { status, headers: { 'x-handover-error-code': code } });

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
