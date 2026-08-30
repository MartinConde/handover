/** Moves the shell to another admin route in place; the shell listens for the popstate. */
export function navigate(to: string) {
  history.pushState({}, '', to);
  dispatchEvent(new PopStateEvent('popstate'));
}
