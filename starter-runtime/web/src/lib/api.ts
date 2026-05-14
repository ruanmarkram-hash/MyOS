// Token + chatId come from the URL query string (set by the Telegram deep
// link or by a saved bookmark). We persist both to sessionStorage on first
// load so subsequent navigations keep working without rewriting the URL.
// We never use localStorage: dashboardToken is sensitive, and storing it
// across browser sessions would enlarge its blast radius.

const url = new URL(window.location.href);

let cachedToken = url.searchParams.get('token') || '';
if (cachedToken) {
  try { sessionStorage.setItem('claudeclaw.token', cachedToken); } catch {}
} else {
  try { cachedToken = sessionStorage.getItem('claudeclaw.token') || ''; } catch {}
}

let cachedChatId = url.searchParams.get('chatId') || '';
if (cachedChatId) {
  try { sessionStorage.setItem('claudeclaw.chatId', cachedChatId); } catch {}
} else {
  try { cachedChatId = sessionStorage.getItem('claudeclaw.chatId') || ''; } catch {}
}

export const dashboardToken = cachedToken;
export const chatId = cachedChatId;

function currentPathWithoutToken(): string {
  const next = new URL(window.location.href);
  next.searchParams.delete('token');
  return `${next.pathname}${next.search}${next.hash}`;
}

function redirectToLogin(): void {
  try {
    sessionStorage.removeItem('claudeclaw.token');
  } catch {}
  const next = currentPathWithoutToken();
  if (window.location.pathname !== '/login') {
    window.location.assign(`/login?next=${encodeURIComponent(next)}`);
  }
}

function withToken(path: string): string {
  if (!dashboardToken) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}token=${encodeURIComponent(dashboardToken)}`;
}

export class ApiError extends Error {
  constructor(public status: number, public body: unknown, message: string) {
    super(message);
  }
}

export function apiErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as any;
    return body?.error || body?.message || err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

async function parseApiError(res: Response, path: string, method: string): Promise<never> {
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) redirectToLogin();
  throw new ApiError(res.status, body, `${method} ${path} failed: ${res.status}`);
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(withToken(path), { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) {
    await parseApiError(res, path, 'GET');
  }
  return res.json();
}

export async function apiPost<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(withToken(path), {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    await parseApiError(res, path, 'POST');
  }
  return res.json();
}

export async function apiPut<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(withToken(path), {
    method: 'PUT',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    await parseApiError(res, path, 'PUT');
  }
  return res.json();
}

export async function apiPatch<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(withToken(path), {
    method: 'PATCH',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    await parseApiError(res, path, 'PATCH');
  }
  return res.json();
}

export async function apiDelete<T = unknown>(path: string): Promise<T> {
  const res = await fetch(withToken(path), { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) {
    await parseApiError(res, path, 'DELETE');
  }
  return res.json();
}

export function tokenizedSseUrl(path: string): string {
  return withToken(path);
}
