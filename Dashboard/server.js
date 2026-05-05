#!/usr/bin/env node
/**
 * Dashboard Server
 *
 * Serves the dashboard at http://localhost:3000
 * AND proxies any external URL at /proxy/<url> so every site
 * loads in the embedded browser (strips X-Frame-Options / CSP headers).
 *
 * Requirements: Node.js — no npm install needed.
 *
 * Usage:
 *   node server.js
 *
 * Then open http://localhost:3000 in your browser.
 */

'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = 3000;
const ROOT = __dirname;

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

// ── Proxy helpers ─────────────────────────────────────────────────────────────
const PROXY_BASE  = `http://localhost:${PORT}/proxy/`;
const SKIP_SCHEME = /^(data:|javascript:|mailto:|tel:|#)/i;

function toAbs(val, base) {
  try { return new URL(val, base).href; } catch { return null; }
}

function rewriteHtml(html, base) {
  html = html.replace(/<base\b[^>]*>/gi, '');

  // Strip inline CSP meta tags — Google and others embed these in the HTML body
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
  fwdHeaders.host   = parsed.hostname;
  fwdHeaders.origin = parsed.origin;
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
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const out  = isHtml ? rewriteHtml(body, targetUrl) : rewriteCss(body, targetUrl);
        delete hdrs['content-length'];
        res.writeHead(proxyRes.statusCode, hdrs);
        res.end(out);
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
  console.log('│  Proxy ready — any site will load in browser  │');
  console.log('└──────────────────────────────────────────────┘\n');
  console.log('Press Ctrl+C to stop.\n');

  // Auto-open in default browser
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
