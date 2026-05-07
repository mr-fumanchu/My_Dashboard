#!/usr/bin/env node
/**
 * Dashboard Server
 *
 * Serves the dashboard at http://localhost:3000
 * AND proxies any external URL at /proxy/<url> so every site
 * loads in the embedded browser (strips X-Frame-Options / CSP headers).
 *
 * HTML/CSS rewriting is offloaded to worker threads so the main event loop
 * never blocks, even on large pages.
 *
 * Requirements: Node.js — no npm install needed.
 *
 * Usage:
 *   node server.js
 *
 * Then open http://localhost:3000 in your browser.
 */

'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const PORT = 3000;

// ── Proxy rewrite helpers ─────────────────────────────────────────────────────
// These are defined at the top level so they're available in both the main
// thread and in worker threads (which re-run this same file).

const PROXY_BASE  = `http://localhost:${PORT}/proxy/`;
const SKIP_SCHEME = /^(data:|javascript:|mailto:|tel:|#)/i;

function toAbs(val, base) {
  try { return new URL(val, base).href; } catch { return null; }
}

function rewriteHtml(html, base) {
  html = html.replace(/<base\b[^>]*>/gi, '');

  // Strip inline CSP meta tags
  html = html.replace(/<meta[^>]+http-equiv\s*=\s*["']content-security-policy["'][^>]*>/gi, '');
  html = html.replace(/<meta[^>]+content-security-policy[^>]*/gi, '');

  html = html.replace(
    /(\b(?:href|src|action|data-src|poster)\s*=\s*)(['"])([^'"]*)\2/gi,
    (m, attr, q, val) => {
      if (SKIP_SCHEME.test(val.trim())) return m;
      const abs = toAbs(val, base);
      return abs ? `${attr}"${PROXY_BASE}${abs}"` : m;
    }
  );

  html = html.replace(
    /(\bsrcset\s*=\s*)(['"])([^'"]*)\2/gi,
    (m, attr, q, val) => {
      const rw = val.replace(/([^\s,]+)(\s*(?:\d+(?:\.\d+)?[wx])?)/g, (part, u, desc) => {
        if (SKIP_SCHEME.test(u.trim())) return part;
        const abs = toAbs(u.trim(), base);
        return abs ? `${PROXY_BASE}${abs}${desc}` : part;
      });
      return `${attr}"${rw}"`;
    }
  );

  html = html.replace(
    /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi,
    (m, q, val) => {
      if (SKIP_SCHEME.test(val.trim())) return m;
      const abs = toAbs(val, base);
      return abs ? `url("${PROXY_BASE}${abs}")` : m;
    }
  );

  return html;
}

function rewriteCss(css, base) {
  return css.replace(
    /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi,
    (m, q, val) => {
      if (SKIP_SCHEME.test(val.trim())) return m;
      const abs = toAbs(val, base);
      return abs ? `url("${PROXY_BASE}${abs}")` : m;
    }
  );
}

// ── Worker entry point ────────────────────────────────────────────────────────
// When this file is loaded as a worker thread, do the rewriting and exit.
// The main server code below is skipped entirely.
if (!isMainThread) {
  const { body, targetUrl, isHtml } = workerData;
  try {
    parentPort.postMessage(
      isHtml ? rewriteHtml(body, targetUrl) : rewriteCss(body, targetUrl)
    );
  } catch (e) {
    parentPort.postMessage(body); // fallback: return original on error
  }
  // Worker exits naturally — nothing else keeping the event loop alive.
  return; // suppress rest of file in worker context (Node evaluates but won't reach requires below)
}

// ── Main thread only ──────────────────────────────────────────────────────────
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const ROOT = __dirname;

// ── Firebase REST helpers ─────────────────────────────────────────────────────
const FB_SRV = 'https://dashboard-database-679ab-default-rtdb.firebaseio.com';

function fbSrvGet(path) {
  return new Promise((resolve, reject) => {
    https.get(`${FB_SRV}/${path}.json`, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Firebase parse')); } });
    }).on('error', reject);
  });
}

function fbSrvPut(path, value) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(value ?? null);
    const u    = new URL(`${FB_SRV}/${path}.json`);
    const r    = https.request({
      hostname: u.hostname, path: u.pathname, method: 'PUT',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => { res.resume(); res.on('end', resolve); });
    r.on('error', reject); r.write(body); r.end();
  });
}

// ── Static file MIME types ────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
};

// ── Proxy ─────────────────────────────────────────────────────────────────────
function doProxy(targetUrl, req, res) {
  let parsed;
  try { parsed = new URL(targetUrl); }
  catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid URL');
    return;
  }

  const lib  = parsed.protocol === 'https:' ? https : http;
  const port = parsed.port
    ? parseInt(parsed.port, 10)
    : (parsed.protocol === 'https:' ? 443 : 80);

  const fwdHeaders = Object.assign({}, req.headers);
  fwdHeaders.host    = parsed.hostname;
  fwdHeaders.origin  = parsed.origin;
  fwdHeaders.referer = targetUrl;
  delete fwdHeaders['content-length'];
  delete fwdHeaders['accept-encoding'];

  const opts = {
    hostname: parsed.hostname,
    port,
    path:    parsed.pathname + (parsed.search || ''),
    method:  req.method,
    headers: fwdHeaders,
    rejectUnauthorized: false,
    timeout: 15000,
  };

  const proxyReq = lib.request(opts, (proxyRes) => {
    const hdrs = Object.assign({}, proxyRes.headers);

    delete hdrs['x-frame-options'];
    delete hdrs['content-security-policy'];
    delete hdrs['content-security-policy-report-only'];
    delete hdrs['strict-transport-security'];
    hdrs['access-control-allow-origin'] = '*';

    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && hdrs.location) {
      try {
        const abs = new URL(hdrs.location, targetUrl).href;
        hdrs.location = `/proxy/${abs}`;
      } catch {}
    }

    const ct     = (hdrs['content-type'] || '').toLowerCase();
    const isHtml = ct.includes('text/html');
    const isCss  = ct.includes('text/css');

    if (isHtml || isCss) {
      // Buffer the full response, then rewrite in a worker thread.
      // This keeps the main event loop free regardless of page size.
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');

        const worker = new Worker(__filename, {
          workerData: { body, targetUrl, isHtml },
        });

        worker.once('message', out => {
          delete hdrs['content-length'];
          res.writeHead(proxyRes.statusCode, hdrs);
          res.end(out);
        });

        worker.once('error', () => {
          // Worker failed — send original without rewriting
          delete hdrs['content-length'];
          res.writeHead(proxyRes.statusCode, hdrs);
          res.end(body);
        });
      });
    } else {
      res.writeHead(proxyRes.statusCode, hdrs);
      proxyRes.pipe(res, { end: true });
    }
  });

  proxyReq.on('timeout', () => proxyReq.destroy());
  proxyReq.on('error', err => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Proxy error: ${err.message}`);
  });

  req.method !== 'GET' && req.method !== 'HEAD'
    ? req.pipe(proxyReq, { end: true })
    : proxyReq.end();
}

// ── LLM API proxy ─────────────────────────────────────────────────────────────
function proxyLlm(provider, { key, messages = [], model, system }, res) {
  if (!key) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'API key required' }));
    return;
  }

  let targetUrl, body, headers;

  if (provider === 'claude') {
    targetUrl = 'https://api.anthropic.com/v1/messages';
    headers   = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    const payload = { model: model || 'claude-sonnet-4-6', max_tokens: 4096, messages };
    if (system) payload.system = system;
    body = JSON.stringify(payload);

  } else if (provider === 'chatgpt') {
    targetUrl = 'https://api.openai.com/v1/chat/completions';
    headers   = { 'content-type': 'application/json', 'authorization': `Bearer ${key}` };
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
    body = JSON.stringify({ model: model || 'gpt-4o', messages: msgs });

  } else if (provider === 'gemini') {
    const m   = model || 'gemini-1.5-flash';
    targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(key)}`;
    headers   = { 'content-type': 'application/json' };
    const contents = messages.map(msg => ({
      role:  msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    }));
    body = JSON.stringify({ contents });

  } else if (provider === 'perplexity') {
    targetUrl = 'https://api.perplexity.ai/chat/completions';
    headers   = { 'content-type': 'application/json', 'authorization': `Bearer ${key}` };
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
    body = JSON.stringify({ model: model || 'sonar', messages: msgs });

  } else if (provider === 'grok') {
    targetUrl = 'https://api.x.ai/v1/chat/completions';
    headers   = { 'content-type': 'application/json', 'authorization': `Bearer ${key}` };
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
    body = JSON.stringify({ model: model || 'grok-beta', messages: msgs });

  } else {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Unknown provider: ${provider}` }));
    return;
  }

  headers['content-length'] = Buffer.byteLength(body);
  const parsed = new URL(targetUrl);
  const lib    = parsed.protocol === 'https:' ? https : http;

  const pr = lib.request({
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path:     parsed.pathname + (parsed.search || ''),
    method:   'POST',
    headers,
    rejectUnauthorized: false,
    timeout:  60000,
  }, pRes => {
    const chunks = [];
    pRes.on('data', c => chunks.push(c));
    pRes.on('end', () => {
      res.writeHead(pRes.statusCode, {
        'content-type':                'application/json',
        'access-control-allow-origin': '*',
      });
      res.end(Buffer.concat(chunks));
    });
  });

  pr.on('timeout', () => pr.destroy());
  pr.on('error', err => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });

  pr.write(body);
  pr.end();
}

// ── Main request handler ──────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // ── Proxy route ─────────────────────────────────────────────────
  if (req.url.startsWith('/proxy/')) {
    let target;
    try { target = decodeURIComponent(req.url.slice(7)); }
    catch { target = req.url.slice(7); }
    doProxy(target, req, res);
    return;
  }

  // ── LLM API route ────────────────────────────────────────────────
  if (req.url.startsWith('/llm/') && req.method === 'POST') {
    const provider = req.url.slice(5).replace(/[/?].*$/, '');
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      proxyLlm(provider, payload, res);
    });
    return;
  }

  // ── Google OAuth routes ──────────────────────────────────────────
  if (req.url === '/oauth/google/start' || req.url.startsWith('/oauth/google/callback')) {
    (async () => {
      const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

      if (req.url === '/oauth/google/start') {
        const creds = await fbSrvGet('settings/gmail/oauth');
        if (!creds || !creds.clientId) {
          res.writeHead(302, { Location: '/mail-settings.html?oauth=no-creds' });
          res.end();
          return;
        }
        const params = new URLSearchParams({
          client_id:     creds.clientId,
          redirect_uri:  'http://localhost:3000/oauth/google/callback',
          response_type: 'code',
          scope:         'https://mail.google.com/ https://www.googleapis.com/auth/userinfo.email',
          access_type:   'offline',
          prompt:        'consent',
        });
        res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
        res.end();
        return;
      }

      // /oauth/google/callback
      const code = reqUrl.searchParams.get('code');
      if (!code) {
        res.writeHead(302, { Location: '/mail-settings.html?oauth=cancelled' });
        res.end();
        return;
      }

      const creds = await fbSrvGet('settings/gmail/oauth');
      if (!creds || !creds.clientId) {
        res.writeHead(302, { Location: '/mail-settings.html?oauth=no-creds' });
        res.end();
        return;
      }

      // Exchange code for tokens
      const tokenBody = new URLSearchParams({
        code,
        client_id:     creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri:  'http://localhost:3000/oauth/google/callback',
        grant_type:    'authorization_code',
      }).toString();

      const tokens = await new Promise((resolve, reject) => {
        const postOpts = {
          hostname: 'oauth2.googleapis.com',
          path:     '/token',
          method:   'POST',
          headers:  {
            'content-type':   'application/x-www-form-urlencoded',
            'content-length': Buffer.byteLength(tokenBody),
          },
        };
        const pr = https.request(postOpts, r => {
          let d = '';
          r.on('data', c => d += c);
          r.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Token parse')); } });
        });
        pr.on('error', reject);
        pr.write(tokenBody);
        pr.end();
      });

      if (!tokens.access_token) {
        const msg = encodeURIComponent(tokens.error_description || tokens.error || 'Token exchange failed');
        res.writeHead(302, { Location: `/mail-settings.html?oauth=error&msg=${msg}` });
        res.end();
        return;
      }

      // Fetch user email
      const userInfo = await new Promise((resolve, reject) => {
        const gr = https.get('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        }, r => {
          let d = '';
          r.on('data', c => d += c);
          r.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Userinfo parse')); } });
        });
        gr.on('error', reject);
      });

      await fbSrvPut('settings/gmail/tokens', {
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token || null,
        expires_in:    tokens.expires_in || null,
        token_type:    tokens.token_type || 'Bearer',
        email:         userInfo.email || null,
        obtained_at:   Date.now(),
      });

      const emailEnc = encodeURIComponent(userInfo.email || '');
      res.writeHead(302, { Location: `/mail-settings.html?oauth=success&email=${emailEnc}` });
      res.end();
    })().catch(err => {
      const msg = encodeURIComponent(err.message || 'Unknown error');
      res.writeHead(302, { Location: `/mail-settings.html?oauth=error&msg=${msg}` });
      res.end();
    });
    return;
  }

  // ── Static file serving ─────────────────────────────────────────
  let filePath = path.join(ROOT, req.url === '/' ? '/index.html' : req.url);

  // Prevent directory traversal outside ROOT
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  // If path has no extension, try .html
  if (!path.extname(filePath)) filePath += '.html';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n┌──────────────────────────────────────────────┐');
  console.log(`│  Dashboard  →  http://localhost:${PORT}           │`);
  console.log('│  Proxy ready — any site will load in browser  │`');
  console.log('└──────────────────────────────────────────────┘\n');
  console.log('Press Ctrl+C to stop.\n');

  const { exec } = require('child_process');
  exec(`open http://localhost:${PORT}`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use.`);
    console.error(`Try: open http://localhost:${PORT}\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
