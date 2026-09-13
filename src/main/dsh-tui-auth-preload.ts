(() => {
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== 'function') return;

  let cookie = process.env.DSH_COOKIE || '';
  const token = process.env.DSH_TOKEN || '';
  const baseUrl = String(process.env.DSH_URL || '').replace(/\/+$/, '');
  let pending: Promise<void> | null = null;

  function cookieFromHeaders(headers: Headers): string {
    const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    if (list.length > 0) {
      return list.map(entry => entry.split(';')[0] || '').filter(Boolean).join('; ');
    }
    const single = headers.get('set-cookie');
    return single ? (single.split(';')[0] || '') : '';
  }

  async function ensureCookie(): Promise<void> {
    if (cookie || !token || !baseUrl) return;
    const response = await originalFetch(`${baseUrl}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    cookie = cookieFromHeaders(response.headers);
  }

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!pending) pending = ensureCookie();
    await pending;
    if (!cookie) return originalFetch(input, init);
    const headers = new Headers(init?.headers);
    if (!headers.has('cookie')) headers.set('cookie', cookie);
    return originalFetch(input, { ...init, headers });
  };
})();
