'use strict';

const FB_DB = 'https://dashboard-database-679ab-default-rtdb.firebaseio.com';

async function fbGet(path) {
  const r = await fetch(`${FB_DB}/${path}.json`);
  if (!r.ok) throw new Error(`Firebase GET /${path} → ${r.status}`);
  return r.json();
}

async function fbSet(path, data) {
  const r = await fetch(`${FB_DB}/${path}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data ?? null),
  });
  if (!r.ok) throw new Error(`Firebase PUT /${path} → ${r.status}`);
  return r.json();
}

async function fbPush(path, data) {
  const r = await fetch(`${FB_DB}/${path}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`Firebase POST /${path} → ${r.status}`);
  return r.json(); // { name: "-pushId" }
}

async function fbUpdate(path, data) {
  const r = await fetch(`${FB_DB}/${path}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`Firebase PATCH /${path} → ${r.status}`);
  return r.json();
}

async function fbDelete(path) {
  const r = await fetch(`${FB_DB}/${path}.json`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`Firebase DELETE /${path} → ${r.status}`);
}

// Real-time listener via Server-Sent Events.
// cb(data, path, isPatch) fires on initial load and every subsequent change.
// Returns the EventSource so caller can call .close() to stop.
function fbListen(path, cb) {
  const es = new EventSource(`${FB_DB}/${path}.json`);
  es.addEventListener('put', e => {
    const { path: p, data } = JSON.parse(e.data);
    cb(data, p, false);
  });
  es.addEventListener('patch', e => {
    const { path: p, data } = JSON.parse(e.data);
    cb(data, p, true);
  });
  es.onerror = () => {}; // browser auto-reconnects
  return es;
}

// Firebase may return numeric-keyed objects instead of arrays.
// This normalises them back to arrays.
function fbToArray(val) {
  if (val === null || val === undefined) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === 'object') {
    const keys = Object.keys(val);
    if (keys.every(k => /^\d+$/.test(k)))
      return keys.sort((a, b) => +a - +b).map(k => val[k]);
    return Object.values(val);
  }
  return [];
}
