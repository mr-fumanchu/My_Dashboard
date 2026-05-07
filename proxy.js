#!/usr/bin/env node
/**
 * Dashboard Browser Proxy
 *
 * Strips X-Frame-Options and Content-Security-Policy headers so any
 * website can load inside the dashboard's embedded browser.
 *
 * Requirements: Node.js (no npm install needed — built-ins only)
 *
 * Usage:
 *   node proxy.js
 *
 * Then open the dashboard, click a browser tab, and enable the 🛡 proxy
 * button in the browser toolbar. Any URL will now load in the frame.
 */

'use strict';

const http  = require('http');
const https = require('https');
const url   = require('url');

const PORT       = 3002;
const PROXY_BASE = `http://localhost:${PORT}/proxy/`;

// ── URL rewriting ────────────────────────────────────────────────────────────
// For HTML and CSS responses, rewrite all resource URLs so they also go
// through the proxy. This makes relative links, stylesheets, and images work.

const SKIP_SCHEMES = /^(data:|javascript:|mailto:|tel:|#)/i;

function toAbs(val, base) {
  try { return new URL(val, base).href; } catch { return null; }
}

function rewriteHtml(html, base) {
  // Remove any <base> tag — it would conflict with our URL rewriting
  html = html.replace(/<base\b[^>]*>/gi, '');

  // Rewrite attribute values: href, src, action, srcset, data-src, poster
  html = html.replace(
    /(\b(?:href|src|action|data-src|poster)\s*=\s*)(['"])([^'"]*)\2/gi,
    (m, attr, q, val) => {
      if (SKIP_SCHEMES.test(val.trim())) return m;
      const abs = toAbs(val, base);
      return abs ? `${attr}"${PROXY_BASE}${abs}"` : m;
    }
  );

  // Rewrite srcset="url 2x, url2 3x"
  html = html.replace(
    /(\bsrcset\s*=\s*)(['"])([^'"]*)\2/gi,
    (m, attr, q, val) => {
      const rewritten = val.replace(/([^\s,]+)(\s*(?:\d+(?:\.\d+)?[wx])?)/g, (part, u, desc) => {
        if (SKIP_SCHEMES.test(u.trim())) return part;
        const abs = toAbs(u.trim(), base);
        return abs ? `${PROXY_BASE}${abs}${desc}` : part;
      });
      return `${attr}"${rewritten}"`;
    }
  );

  // Rewrite url(...) in inline styles
  html = html.replace(
    /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi,
    (m, q, val) => {
      if (SKIP_SCHEMES.test(val.trim())) return m;
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
      if (SKIP_SCHEMES.test(val.trim())) return m;
      const abs = toAbs(val, base);
      return abs ? `url("${PROXY_BASE}${abs}")` : m;
    }
  );
}

// ── Proxy server ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // CORS — allow the dashboard (any origin) to use this proxy
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health check used by the dashboard to detect the proxy
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // All proxied requests must start with /proxy/<target-url>
  if (!req.url.startsWith('/proxy/')) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Usage: /proxy/<full-url>  e.g.  /proxy/https://example.com/');
    return;
  }

  // Extract target URL (may be percent-encoded)
  let targetUrl;
  try {
    targetUrl = decodeURIComponent(req.url.slice('/proxy/'.length));
  } catch {
    targetUrl = req.url.slice('/proxy/'.length);
  }

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

  // Build forwarded request headers — strip a few that cause issues
  const fwdHeaders = Object.assign({}, req.headers);
  fwdHeaders.host   = parsed.hostname;
  fwdHeaders.origin = parsed.origin;
  fwdHeaders.referer = targetUrl;
  delete fwdHeaders['content-length'];  // will be recalculated if needed
  delete fwdHeaders['accept-encoding']; // avoid gzip so we can rewrite text

  const opts = {
    hostname: parsed.hostname,
    port,
    path:   parsed.pathname + (parsed.search || ''),
    method: req.method,
    headers: fwdHeaders,
    rejectUnauthorized: false,  // allow self-signed certs on local sites
    timeout: 15000,
  };

  const proxyReq = lib.request(opts, (proxyRes) => {
    const hdrs = Object.assign({}, proxyRes.headers);

    // Strip frame-blocking headers — this is the core purpose of the proxy
    delete hdrs['x-frame-options'];
    delete hdrs['content-security-policy'];
    delete hdrs['content-security-policy-report-only'];
    delete hdrs['strict-transport-security'];

    // Allow the dashboard to read the response
    hdrs['access-control-allow-origin'] = '*';

    // Rewrite redirect locations to go through the proxy
    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && hdrs.location) {
      try {
        const absLoc = new URL(hdrs.location, targetUrl).href;
        hdrs.location = `/proxy/${absLoc}`;
      } catch {}
    }

    const ct     = (hdrs['content-type'] || '').toLowerCase();
    const isHtml = ct.includes('text/html');
    const isCss  = ct.includes('text/css');

    if (isHtml || isCss) {
      // Buffer the body so we can rewrite URLs
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const rewritten = isHtml ? rewriteHtml(body, targetUrl) : rewriteCss(body, targetUrl);
        delete hdrs['content-length'];
        res.writeHead(proxyRes.statusCode, hdrs);
        res.end(rewritten);
      });
    } else {
      // Binary / JSON / etc — stream straight through
      res.writeHead(proxyRes.statusCode, hdrs);
      proxyRes.pipe(res, { end: true });
    }
  });

  proxyReq.on('timeout', () => { proxyReq.destroy(); });
  proxyReq.on('error', err => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Proxy error: ${err.message}`);
  });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.pipe(proxyReq, { end: true });
  } else {
    proxyReq.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n┌─────────────────────────────────────────┐');
  console.log(`│  Dashboard Proxy  →  http://localhost:${PORT}  │`);
  console.log('└─────────────────────────────────────────┘');
  console.log('\nOpen the dashboard, click a browser tab, then');
  console.log('enable the 🛡  button in the browser toolbar.');
  console.log('\nPress Ctrl+C to stop.\n');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use.`);
    console.error('Another proxy may already be running — that is fine, just enable the 🛡 button in the dashboard.\n');
  } else {
    console.error(err);
  }
  process.exit(1);
});
