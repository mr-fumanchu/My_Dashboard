#!/usr/bin/env node
'use strict';
/**
 * Mail Proxy — http://localhost:3001
 *
 * Bridges the dashboard browser to IMAP/Gmail accounts.
 * Reads account credentials from Firebase; no npm required.
 *
 * Routes:
 *   GET /mail/:email/:folder   → { messages: [...] }
 *
 * Start with:
 *   node mail-proxy.js
 */

const http  = require('http');
const https = require('https');
const tls   = require('tls');
const net   = require('net');

const PORT   = 3001;
const FB_DB  = 'https://dashboard-database-679ab-default-rtdb.firebaseio.com';

// ── Firebase REST helpers ─────────────────────────────────────────────────────
function fbGet(path) {
  return new Promise((resolve, reject) => {
    https.get(`${FB_DB}/${path}.json`, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Firebase parse')); } });
    }).on('error', reject);
  });
}

// ── HTTPS helpers ─────────────────────────────────────────────────────────────
function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: headers || {} }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('JSON parse')); } });
    }).on('error', reject);
  });
}

// ── Gmail REST API ────────────────────────────────────────────────────────────
async function gmailFetch(tokens, folder) {
  const LABEL = { inbox: 'INBOX', sent: 'SENT', drafts: 'DRAFT', archive: 'ARCHIVE', spam: 'SPAM', trash: 'TRASH' };
  const labelId = LABEL[folder] || 'INBOX';
  const auth    = { Authorization: `Bearer ${tokens.accessToken}` };

  const list = await httpsGet(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=${labelId}&maxResults=20`, auth
  );
  if (!list.messages?.length) return [];

  const results = await Promise.all(list.messages.map(m =>
    httpsGet(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}` +
      `?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, auth
    ).then(msg => {
      const hdrs = {};
      (msg.payload?.headers || []).forEach(h => { hdrs[h.name.toLowerCase()] = h.value; });
      let dateStr = '';
      try {
        const d = new Date(hdrs.date || '');
        if (!isNaN(d)) dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      } catch {}
      return {
        from:    hdrs.from    || '—',
        subject: hdrs.subject || '(no subject)',
        date:    dateStr,
        unread:  (msg.labelIds || []).includes('UNREAD'),
        preview: msg.snippet  || '',
      };
    }).catch(() => null)
  ));
  return results.filter(Boolean);
}

// ── IMAP client ───────────────────────────────────────────────────────────────
const GMAIL_FOLDERS = { inbox:'INBOX', sent:'[Gmail]/Sent Mail', drafts:'[Gmail]/Drafts',
                        archive:'[Gmail]/All Mail', spam:'[Gmail]/Spam', trash:'[Gmail]/Trash' };
const STD_FOLDERS   = { inbox:'INBOX', sent:'Sent', drafts:'Drafts',
                        archive:'Archive', spam:'Junk', trash:'Trash' };

function quoteMailbox(name) {
  return (name.includes(' ') || name.includes('/')) ? `"${name}"` : name;
}
function escImap(s) {
  return `"${String(s).replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`;
}

function imapFetch(acc, folder) {
  const isGmail  = acc.type === 'gmail' || (acc.incHost || '').includes('gmail');
  const folderMap = isGmail ? GMAIL_FOLDERS : STD_FOLDERS;
  const mailbox  = quoteMailbox(folderMap[folder] || 'INBOX');
  const host     = acc.incHost;
  const port     = parseInt(acc.incPort) || 993;
  const useTls   = acc.incSsl !== false;

  return new Promise((resolve, reject) => {
    const socket = useTls
      ? tls.connect(port, host, { rejectUnauthorized: false })
      : net.connect(port, host);

    socket.setTimeout(20000);
    socket.on('timeout', () => { socket.destroy(); reject(new Error('IMAP timeout')); });
    socket.on('error',   reject);

    let rawBuf   = Buffer.alloc(0);
    let litLeft  = 0;
    let litAccum = '';
    let seq      = 0;
    let pending  = null; // { tag, lines[], resolve, reject }
    let greeted  = false;

    function nextTag() { return `M${++seq}`; }

    function sendCmd(cmd) {
      const tag = nextTag();
      return new Promise((res, rej) => {
        pending = { tag, lines: [], resolve: res, reject: rej };
        socket.write(`${tag} ${cmd}\r\n`);
      });
    }

    function processBuffer() {
      while (rawBuf.length) {
        if (litLeft > 0) {
          const take = Math.min(litLeft, rawBuf.length);
          litAccum += rawBuf.slice(0, take).toString('utf8');
          rawBuf    = rawBuf.slice(take);
          litLeft  -= take;
          if (litLeft === 0 && pending) {
            pending.lines.push('LITERAL\n' + litAccum);
            litAccum = '';
          }
          continue;
        }

        const crlf = rawBuf.indexOf(Buffer.from('\r\n'));
        if (crlf === -1) break;

        const line = rawBuf.slice(0, crlf).toString('utf8');
        rawBuf = rawBuf.slice(crlf + 2);

        const litMatch = line.match(/\{(\d+)\}$/);
        if (litMatch) {
          litLeft = parseInt(litMatch[1]);
          if (pending) pending.lines.push(line);
          continue;
        }

        if (!greeted && (line.startsWith('* OK') || line.startsWith('* PREAUTH'))) {
          greeted = true;
          runSession().then(resolve).catch(err => { socket.destroy(); reject(err); });
          continue;
        }

        if (pending) {
          pending.lines.push(line);
          if (line.startsWith(pending.tag + ' ')) {
            const ok  = /\bOK\b/.test(line.slice(pending.tag.length + 1, pending.tag.length + 5));
            const p   = pending;
            pending   = null;
            if (ok) p.resolve(p.lines.join('\n'));
            else    p.reject(new Error('IMAP: ' + line));
          }
        }
      }
    }

    socket.on('data', chunk => {
      rawBuf = Buffer.concat([rawBuf, chunk]);
      processBuffer();
    });

    async function runSession() {
      await sendCmd(`LOGIN ${escImap(acc.user || acc.email)} ${escImap(acc.pass)}`);

      const selResp = await sendCmd(`SELECT ${mailbox}`);
      const exists  = (selResp.match(/\* (\d+) EXISTS/) || [])[1];
      const count   = parseInt(exists) || 0;

      if (!count) {
        await sendCmd('LOGOUT').catch(() => {});
        socket.destroy();
        return [];
      }

      const start     = Math.max(1, count - 19);
      const fetchResp = await sendCmd(
        `FETCH ${start}:${count} (FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`
      );
      await sendCmd('LOGOUT').catch(() => {});
      socket.destroy();
      return parseFetch(fetchResp);
    }
  });
}

function parseFetch(raw) {
  const messages = [];
  // Split on untagged FETCH lines
  const blocks = raw.split(/(?=\* \d+ FETCH)/);
  for (const block of blocks) {
    if (!block.includes('FETCH')) continue;
    const flags   = (block.match(/FLAGS \(([^)]*)\)/) || [])[1] || '';
    const isUnread = !flags.includes('\\Seen');

    // Find the literal content (lines after "LITERAL\n")
    const litIdx = block.indexOf('LITERAL\n');
    const headers = litIdx !== -1 ? block.slice(litIdx + 8) : '';

    let from = '', subject = '', date = '';
    for (const l of headers.split('\n')) {
      if (/^From:/i.test(l))    from    = l.replace(/^From:\s*/i, '').trim();
      if (/^Subject:/i.test(l)) subject = l.replace(/^Subject:\s*/i, '').trim();
      if (/^Date:/i.test(l))    date    = l.replace(/^Date:\s*/i, '').trim();
    }

    let dateStr = '';
    try {
      const d = new Date(date);
      if (!isNaN(d.getTime())) dateStr = d.toLocaleDateString('en-US', { month:'short', day:'numeric' });
    } catch {}

    if (from || subject) {
      messages.push({ from: from || '—', subject: subject || '(no subject)',
                      date: dateStr, unread: isUnread, preview: '' });
    }
  }
  return messages.reverse(); // most recent first
}

// ── Request handler ───────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  const match = req.url.match(/^\/mail\/([^/]+)\/([^/?]+)/);
  if (!match) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Usage: /mail/:email/:folder' }));
  }

  const email  = decodeURIComponent(match[1]).toLowerCase();
  const folder = match[2].toLowerCase();

  try {
    // 1. Gmail OAuth
    const gmailTokens = await fbGet('settings/gmail/tokens').catch(() => null);
    if (gmailTokens?.email?.toLowerCase() === email) {
      const messages = await gmailFetch(gmailTokens, folder);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ messages }));
    }

    // 2. IMAP account
    const rawAccts = await fbGet('settings/mailAccounts').catch(() => null);
    const accts    = rawAccts ? (Array.isArray(rawAccts) ? rawAccts : Object.values(rawAccts)) : [];
    const acc      = accts.find(a => (a.email || '').toLowerCase() === email);

    if (!acc) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Account not found', messages: [] }));
    }

    const messages = await imapFetch(acc, folder);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages }));

  } catch (err) {
    console.error('Mail proxy error:', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message, messages: [] }));
  }
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message, messages: [] }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n┌──────────────────────────────────────┐');
  console.log(`│  Mail Proxy  →  http://localhost:${PORT}  │`);
  console.log('└──────────────────────────────────────┘\n');
  console.log('Handles: Gmail OAuth (REST API) + IMAP/TLS');
  console.log('Press Ctrl+C to stop.\n');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use — mail proxy may already be running.\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
