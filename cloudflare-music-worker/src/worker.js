addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Internet Archive Music Player</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Arial, "Apple Color Emoji", "Segoe UI Emoji"; margin: 0; padding: 0; }
    header { padding: 1rem; background: #1f2937; color: #fff; }
    main { padding: 1rem; max-width: 920px; margin: 0 auto; }
    .search { display: flex; gap: .5rem; margin-bottom: 1rem; }
    .search input { flex: 1; padding: .6rem .8rem; font-size: 1rem; }
    .search button { padding: .6rem .9rem; font-size: 1rem; cursor: pointer; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { padding: .6rem; border-bottom: 1px solid #e5e7eb22; display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
    .meta { display: flex; flex-direction: column; min-width: 0; }
    .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .creator { color: #6b7280; font-size: .9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .actions button { padding: .35rem .6rem; font-size: .9rem; cursor: pointer; }
    footer { margin-top: 1rem; color: #6b7280; font-size: .9rem; }
    .status { margin: .5rem 0; color: #6b7280; }
    audio { width: 100%; margin-top: .75rem; }
  </style>
</head>
<body>
  <header>
    <h1>Internet Archive Music Player</h1>
  </header>
  <main>
    <div class="search">
      <input id="q" type="search" placeholder="Search music (e.g., Beethoven, lo-fi, podcast)" />
      <button id="btn">Search</button>
    </div>
    <div class="status" id="status">Type a query and press Enter</div>
    <ul id="results"></ul>
    <audio id="player" controls preload="none"></audio>
    <footer>
      Powered by the Internet Archive. Only openly licensed audio is shown. Streaming is proxied with CORS and Range support.
    </footer>
  </main>
  <script>
    const q = document.getElementById('q');
    const btn = document.getElementById('btn');
    const resultsEl = document.getElementById('results');
    const player = document.getElementById('player');
    const statusEl = document.getElementById('status');

    async function search() {
      const query = q.value.trim();
      if (!query) return;
      resultsEl.innerHTML = '';
      statusEl.textContent = 'Searching…';
      try {
        const r = await fetch('/api/search?q=' + encodeURIComponent(query) + '&limit=15');
        if (!r.ok) throw new Error('Search failed: ' + r.status);
        const data = await r.json();
        const results = data.results || [];
        if (results.length === 0) {
          statusEl.textContent = 'No results.';
          return;
        }
        statusEl.textContent = 'Found ' + results.length + ' track' + (results.length === 1 ? '' : 's') + '. Click Play.';
        resultsEl.innerHTML = '';
        for (const item of results) {
          const li = document.createElement('li');
          const meta = document.createElement('div');
          meta.className = 'meta';
          const title = document.createElement('div');
          title.className = 'title';
          title.textContent = item.title || item.identifier;
          const creator = document.createElement('div');
          creator.className = 'creator';
          creator.textContent = item.creator || '';
          meta.appendChild(title);
          meta.appendChild(creator);
          const actions = document.createElement('div');
          actions.className = 'actions';
          const play = document.createElement('button');
          play.textContent = 'Play';
          play.addEventListener('click', () => {
            player.src = item.streamUrl;
            player.play();
          });
          actions.appendChild(play);
          li.appendChild(meta);
          li.appendChild(actions);
          resultsEl.appendChild(li);
        }
      } catch (err) {
        console.error(err);
        statusEl.textContent = 'Error: ' + err.message;
      }
    }

    btn.addEventListener('click', search);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  </script>
</body>
</html>`;

async function handleRequest(request) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === '/' && request.method === 'GET') {
    return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  if (pathname === '/api/search') {
    if (request.method !== 'GET') return jsonError('Method not allowed', 405);
    const q = url.searchParams.get('q')?.trim();
    if (!q) return jsonError('Missing query parameter: q', 400);
    const limitParam = Number(url.searchParams.get('limit')) || 10;
    const limit = Math.max(1, Math.min(limitParam, 25));
    try {
      const results = await searchInternetArchive(q, limit, url.origin);
      return new Response(JSON.stringify({ results }, null, 2), {
        headers: { 'content-type': 'application/json; charset=utf-8' }
      });
    } catch (e) {
      return jsonError('Search failed', 502, e);
    }
  }

  if (pathname === '/api/stream') {
    return handleStream(request);
  }

  if (request.method === 'OPTIONS') {
    return corsResponse(new Response(null, { status: 204 }));
  }

  return new Response('Not Found', { status: 404 });
}

function jsonError(message, status = 400, err) {
  const body = { error: message };
  if (err && typeof err.message === 'string') body.detail = err.message;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

async function searchInternetArchive(query, limit, origin) {
  const q = `(${query}) AND mediatype:(audio) AND licenseurl:*`;
  const params = new URLSearchParams();
  params.set('output', 'json');
  params.set('q', q);
  params.append('fl[]', 'identifier');
  params.append('fl[]', 'title');
  params.append('fl[]', 'creator');
  params.append('fl[]', 'downloads');
  params.append('sort[]', 'downloads desc');
  params.set('rows', String(Math.min(limit * 2, 50))); // fetch more to filter to playable
  params.set('page', '1');

  const searchUrl = 'https://archive.org/advancedsearch.php?' + params.toString();
  const res = await fetch(searchUrl, { headers: { 'accept': 'application/json' } });
  if (!res.ok) throw new Error('advancedsearch error ' + res.status);
  const data = await res.json();
  const docs = Array.isArray(data?.response?.docs) ? data.response.docs : [];

  // Fetch metadata for each identifier to find a playable file
  const out = [];
  for (const doc of docs) {
    if (out.length >= limit) break;
    const identifier = String(doc.identifier || '').trim();
    if (!identifier) continue;
    try {
      const metaUrl = `https://archive.org/metadata/${encodeURIComponent(identifier)}`;
      const mres = await fetch(metaUrl, { headers: { 'accept': 'application/json' } });
      if (!mres.ok) continue;
      const meta = await mres.json();
      const file = pickPlayableFile(meta?.files || []);
      if (!file) continue;
      const fileUrl = buildDownloadUrl(identifier, file.name || '');
      const title = (doc.title || meta?.metadata?.title || identifier);
      const creator = normalizeCreator(doc.creator || meta?.metadata?.creator);
      out.push({
        title,
        creator,
        identifier,
        streamUrl: `/api/stream?url=${encodeURIComponent(fileUrl)}`
      });
    } catch (_) {
      // skip item on error
    }
  }
  return out;
}

function normalizeCreator(c) {
  if (!c) return '';
  if (Array.isArray(c)) return c.filter(Boolean).join(', ');
  return String(c);
}

function pickPlayableFile(files) {
  if (!Array.isArray(files)) return null;
  const lower = s => (s || '').toLowerCase();
  const isPlayable = (f) => {
    const name = lower(f.name);
    const fmt = lower(f.format || '');
    const extOk = name.endsWith('.mp3') || name.endsWith('.ogg');
    const fmtOk = fmt.includes('mp3') || fmt.includes('ogg');
    return (extOk || fmtOk) && !name.endsWith('.m3u') && !name.endsWith('.m3u8');
  };
  // Prefer MP3 first
  const mp3 = files.find(f => isPlayable(f) && lower(f.name).endsWith('.mp3'))
           || files.find(f => isPlayable(f) && lower(f.format || '').includes('mp3'));
  if (mp3) return mp3;
  const ogg = files.find(f => isPlayable(f) && lower(f.name).endsWith('.ogg'))
           || files.find(f => isPlayable(f) && lower(f.format || '').includes('ogg'));
  return ogg || null;
}

function buildDownloadUrl(identifier, name) {
  const safeIdentifier = encodeURIComponent(identifier);
  const safePath = String(name || '').split('/').map(encodeURIComponent).join('/');
  return `https://archive.org/download/${safeIdentifier}/${safePath}`;
}

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag, Last-Modified',
    ...extra,
  };
}

function corsResponse(res) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(corsHeaders())) r.headers.set(k, v);
  return r;
}

async function handleStream(request) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // HEAD is supported similarly to GET but without body
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() }
    });
  }

  const target = url.searchParams.get('url') || '';
  let t;
  try { t = new URL(target); } catch (_) { return new Response(JSON.stringify({ error: 'Invalid or missing url parameter' }), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() } }); }
  const host = t.hostname.toLowerCase();
  const isHttps = t.protocol === 'https:';
  const allowed = isHttps && (host === 'archive.org' || host.endsWith('.archive.org'));
  if (!allowed) {
    return new Response(JSON.stringify({ error: 'Only https URLs on archive.org are allowed' }), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() } });
  }

  const hasRange = request.headers.has('Range');
  const headers = new Headers();
  if (hasRange) headers.set('Range', request.headers.get('Range'));
  // Pass conditional headers to leverage origin caching
  for (const h of ['If-None-Match', 'If-Modified-Since']) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }

  const fetchInit = {
    method,
    headers,
  };

  // Only enable edge caching for non-Range GETs
  if (method === 'GET' && !hasRange) {
    fetchInit.cf = { cacheTtl: 86400, cacheEverything: true };
  }

  let upstream;
  try {
    upstream = await fetch(t.toString(), fetchInit);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Upstream fetch failed' }), { status: 502, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() } });
  }

  // Build response with pass-through headers plus CORS and cache-control (for non-Range GET)
  const respHeaders = new Headers();
  // Copy selected headers from upstream
  const passthroughHeaders = [
    'content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'date', 'cache-control'
  ];
  for (const h of passthroughHeaders) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

  // Caching policy
  if (method === 'GET' && !hasRange) {
    respHeaders.set('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=600');
  } else {
    // Avoid fragment caching of Range responses
    respHeaders.set('Cache-Control', 'no-store');
  }

  const allHeaders = { ...Object.fromEntries(respHeaders), ...corsHeaders() };
  const init = { status: upstream.status, headers: allHeaders };
  if (method === 'HEAD') {
    return new Response(null, init);
  }
  return new Response(upstream.body, init);
}
