'use strict';

function fmtNum(n) {
  if (n == null || n === '') return '—';
  const num = parseInt(n, 10);
  if (isNaN(num)) return String(n);
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (num >= 1_000)     return (num / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return num.toLocaleString();
}

function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function fmtAge(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 7)  return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// ── My Channel ────────────────────────────────────────────────────

function renderTopVideos(raw) {
  const el = document.getElementById('yt-top-videos');
  const videos = raw ? (Array.isArray(raw) ? raw : Object.values(raw)) : [];
  if (!videos.length) {
    el.innerHTML = '<p class="placeholder">No data yet &mdash; click Refresh to fetch from YouTube.</p>';
    return;
  }
  const rows = videos.map(v => `
    <tr>
      <td class="yt-vid-title">
        <a href="https://youtu.be/${v.id}" target="_blank" rel="noopener">${v.title || v.id}</a>
      </td>
      <td class="yt-vid-stat">${fmtNum(v.views)}</td>
      <td class="yt-vid-stat">${fmtNum(v.likes)}</td>
      <td class="yt-vid-stat">${fmtNum(v.comments)}</td>
    </tr>
  `).join('');
  el.innerHTML = `
    <table class="yt-table">
      <thead>
        <tr>
          <th>Title</th>
          <th class="yt-vid-stat">Views</th>
          <th class="yt-vid-stat">Likes</th>
          <th class="yt-vid-stat">Comments</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function applyData(data) {
  document.getElementById('yt-subscribers').textContent = data ? fmtNum(data.subscribers) : '—';
  document.getElementById('yt-views').textContent       = data ? fmtNum(data.totalViews)  : '—';
  document.getElementById('yt-videos').textContent      = data ? fmtNum(data.videoCount)  : '—';
  document.getElementById('yt-updated').textContent     = data ? fmtDate(data.lastUpdated) : '—';
  renderTopVideos(data ? data.topVideos : null);
}

fbListen('analytics/youtube', (data) => {
  if (data && data.nicheWatch === undefined) applyData(data);
  else if (data) applyData(data);
});

fbGet('settings/youtube').then(cfg => {
  if (!cfg || !cfg.apiKey || !cfg.channelId) {
    document.getElementById('yt-setup-notice').style.display = 'block';
  }
}).catch(() => {
  document.getElementById('yt-setup-notice').style.display = 'block';
});

document.getElementById('yt-refresh').addEventListener('click', async () => {
  const btn = document.getElementById('yt-refresh');
  const statusEl  = document.getElementById('yt-status');
  const statusMsg = document.getElementById('yt-status-msg');

  btn.disabled = true;
  btn.textContent = '↻ Fetching…';
  statusEl.style.display = 'block';
  statusMsg.textContent = 'Contacting YouTube API…';

  try {
    const r    = await fetch('/api/youtube/refresh', { method: 'POST' });
    const json = await r.json();
    if (!r.ok) {
      statusMsg.textContent = `Error: ${json.error || r.statusText}`;
      statusEl.classList.add('yt-status-error');
    } else {
      statusMsg.textContent = `Channel refreshed at ${new Date().toLocaleTimeString()}.`;
      statusEl.classList.remove('yt-status-error');
      document.getElementById('yt-setup-notice').style.display = 'none';
    }
  } catch (e) {
    statusMsg.textContent = `Network error: ${e.message}`;
    statusEl.classList.add('yt-status-error');
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ Refresh';
  }
});

// ── Niche Watch ───────────────────────────────────────────────────

function playVideo(videoId) {
  const iframe = document.getElementById('niche-iframe');
  const placeholder = document.getElementById('niche-placeholder');
  iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1`;
  iframe.style.display = 'block';
  placeholder.style.display = 'none';
}

function renderNicheWatch(raw) {
  const el = document.getElementById('niche-list');
  const channels = raw ? (Array.isArray(raw) ? raw : Object.values(raw)) : [];

  if (!channels.length) {
    el.innerHTML = '<p class="placeholder">Add channels to Firebase at <code>settings/youtube/watchChannels</code></p>';
    return;
  }

  el.innerHTML = channels.map(ch => {
    const v = ch.latestVideo;
    const videoSection = ch.error
      ? `<p class="niche-error">Error: ${ch.error}</p>`
      : v
        ? `<button class="niche-video-link" data-vid="${v.id}">${v.title}</button>
           <div class="niche-video-stats">
             <span title="Likes">&#128077; ${fmtNum(v.likes)}</span>
             <span title="Comments">&#128172; ${fmtNum(v.comments)}</span>
             <span title="Published">&#128197; ${fmtAge(v.publishedAt)}</span>
           </div>`
        : `<p class="placeholder" style="font-size:0.8rem">No recent video found</p>`;

    return `
      <div class="niche-channel">
        <div class="niche-channel-header">
          <span class="niche-channel-name">${ch.name}</span>
          <span class="niche-subs">${fmtNum(ch.subscribers)} subs</span>
        </div>
        ${videoSection}
      </div>
    `;
  }).join('');

  el.querySelectorAll('.niche-video-link').forEach(btn => {
    btn.addEventListener('click', () => playVideo(btn.dataset.vid));
  });
}

fbListen('analytics/youtube/nicheWatch', (data) => {
  renderNicheWatch(data);
});

// Last refresh message
fbListen('analytics/youtube/nicheLastRefresh', (data) => {
  const el = document.getElementById('niche-msg-text');
  if (!data) { el.textContent = 'No refresh run yet.'; return; }
  const time = data.timestamp ? ` (${fmtDate(data.timestamp)})` : '';
  el.textContent = data.message + time;
});

// Trending in niche
fbListen('analytics/youtube/nicheTrending', (data) => {
  const el        = document.getElementById('niche-trending');
  const updatedEl = document.getElementById('niche-trending-updated');
  if (!data || !data.videos) {
    el.innerHTML = '<p class="placeholder">Click Niche Watch &#x21BB;&nbsp;Refresh to load trending topics.</p>';
    return;
  }
  const videos = Array.isArray(data.videos) ? data.videos : Object.values(data.videos);
  if (!videos.length) {
    el.innerHTML = '<p class="placeholder">No trending data found.</p>';
    return;
  }
  if (data.fetchedAt) updatedEl.textContent = `as of ${fmtDate(data.fetchedAt)}`;
  const rows = videos.map((v, i) => `
    <tr>
      <td class="niche-trend-rank">${i + 1}</td>
      <td class="yt-vid-title">
        <a href="https://youtu.be/${v.id}" target="_blank" rel="noopener">${v.title}</a>
        <span class="niche-trend-channel">${v.channelName}</span>
      </td>
      <td class="yt-vid-stat">${fmtNum(v.views)}</td>
      <td class="yt-vid-stat">${fmtAge(v.publishedAt)}</td>
    </tr>
  `).join('');
  el.innerHTML = `
    <table class="yt-table">
      <thead>
        <tr>
          <th style="width:2rem">#</th>
          <th>Title</th>
          <th class="yt-vid-stat">Views</th>
          <th class="yt-vid-stat">Posted</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
});

fbListen('analytics/youtube/nicheChangelog', (data) => {
  const wrap = document.getElementById('niche-changelog-wrap');
  const el   = document.getElementById('niche-changelog');
  const entries = data ? (Array.isArray(data) ? data : Object.values(data)) : [];
  if (!entries.length) { wrap.style.display = 'none'; return; }

  wrap.style.display = 'block';
  el.innerHTML = [...entries].reverse().slice(0, 10).map(e => `
    <div class="niche-log-entry">
      <span class="niche-log-date">${fmtDate(e.timestamp)}</span>
      <span class="niche-log-out">&#8592; <a href="https://www.youtube.com/channel/${e.removed.channelId}" target="_blank" rel="noopener">${e.removed.name}</a> (${fmtNum(e.removed.subscribers)} subs)</span>
      <span class="niche-log-in">&#8594; <a href="https://www.youtube.com/channel/${e.added.channelId}" target="_blank" rel="noopener">${e.added.name}</a> (${fmtNum(e.added.subscribers)} subs)</span>
    </div>
  `).join('');
});

document.getElementById('niche-refresh').addEventListener('click', async () => {
  const btn = document.getElementById('niche-refresh');
  const statusEl  = document.getElementById('yt-status');
  const statusMsg = document.getElementById('yt-status-msg');

  btn.disabled = true;
  btn.textContent = '↻ Fetching…';
  statusEl.style.display = 'block';
  statusMsg.textContent = 'Fetching niche channel data…';

  try {
    const r    = await fetch('/api/youtube/niche-refresh', { method: 'POST' });
    const json = await r.json();
    if (!r.ok) {
      statusMsg.textContent = `Niche error: ${json.error || r.statusText}`;
      statusEl.classList.add('yt-status-error');
    } else {
      const swapNote = json.swaps > 0 ? ` — ${json.swaps} channel(s) swapped in based on trending data.` : ' — no lineup changes.';
      statusMsg.textContent = `Niche watch updated at ${new Date().toLocaleTimeString()}${swapNote}`;
      statusEl.classList.remove('yt-status-error');
    }
  } catch (e) {
    statusMsg.textContent = `Network error: ${e.message}`;
    statusEl.classList.add('yt-status-error');
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ Refresh';
  }
});
