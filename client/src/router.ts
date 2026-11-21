import { useSyncExternalStore } from 'react';

// A small router: the path is the state. /<board>/<view>[/<id>], with ?open=<id> for the detail panel.

function subscribe(cb: () => void) {
  window.addEventListener('popstate', cb);
  window.addEventListener('pm:navigate', cb);
  return () => {
    window.removeEventListener('popstate', cb);
    window.removeEventListener('pm:navigate', cb);
  };
}

const snapshot = () => window.location.pathname + window.location.search;

export function useLocation(): { path: string; params: URLSearchParams } {
  const loc = useSyncExternalStore(subscribe, snapshot);
  const [path, query = ''] = loc.split('?');
  return { path, params: new URLSearchParams(query) };
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === snapshot()) return;
  if (opts.replace) history.replaceState({}, '', to);
  else history.pushState({}, '', to);
  window.dispatchEvent(new Event('pm:navigate'));
}

/** The same path with ?open=<id> set, or removed when id is null. */
export function withOpen(id: string | null): string {
  const params = new URLSearchParams(window.location.search);
  if (id) params.set('open', id);
  else params.delete('open');
  const q = params.toString();
  return window.location.pathname + (q ? `?${q}` : '');
}
