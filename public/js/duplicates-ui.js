import { showToast } from './toast.js';
import { t } from './user-locales.js';
import { escapeHtml, formatDate } from './utils.js';

let pollTimer = null;
let currentPair = null;

function $(id) {
    return document.getElementById(id);
}

function formatSize(n) {
    if (!n || n < 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDuration(s) {
    if (!s || s <= 0) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
}

function scanOptionsFromForm() {
    return {
        cosineThreshold: parseFloat(($('dupCosine') || {}).value) || 0.93,
        crossTypeCosine: parseFloat(($('dupCrossCosine') || {}).value) || 0.90,
        sameTypeOnly: !!(($('dupSameTypeOnly') || {}).checked),
        threshold: parseInt(($('dupThreshold') || {}).value, 10) || 5,
        concurrency: parseInt(($('dupConcurrency') || {}).value, 10) || 4,
        intervalSec: parseFloat(($('dupInterval') || {}).value) || 3,
        minVideoHits: parseInt(($('dupMinHits') || {}).value, 10) || 4,
        minGifHits: parseInt(($('dupMinGifHits') || {}).value, 10) || 2,
        minImageVideoHits: parseInt(($('dupMinImageVideoHits') || {}).value, 10) || 2,
        minGifVideoHits: parseInt(($('dupMinGifVideoHits') || {}).value, 10) || 2
    };
}

function wireVideoControls(video, barEl) {
    if (!barEl) return;
    barEl.innerHTML = '';
    barEl.classList.remove('hidden');

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'dup-ctrl-btn';
    playBtn.textContent = '▶';
    playBtn.title = 'Play / Pause';

    const muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = 'dup-ctrl-btn';
    muteBtn.textContent = '🔇';
    muteBtn.title = 'Mute';

    const seek = document.createElement('input');
    seek.type = 'range';
    seek.min = '0';
    seek.max = '1000';
    seek.value = '0';
    seek.className = 'dup-seek';

    const timeLabel = document.createElement('span');
    timeLabel.className = 'dup-time';
    timeLabel.textContent = '0:00 / 0:00';

    const syncPlay = () => {
        playBtn.textContent = video.paused ? '▶' : '⏸';
    };
    playBtn.addEventListener('click', () => {
        if (video.paused) video.play().catch(() => {});
        else video.pause();
    });
    muteBtn.addEventListener('click', () => {
        video.muted = !video.muted;
        muteBtn.textContent = video.muted ? '🔇' : '🔊';
    });
    seek.addEventListener('input', () => {
        if (!video.duration) return;
        video.currentTime = (seek.value / 1000) * video.duration;
    });
    video.addEventListener('play', syncPlay);
    video.addEventListener('pause', syncPlay);
    video.addEventListener('timeupdate', () => {
        if (video.duration) {
            seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
            timeLabel.textContent = `${formatDuration(video.currentTime)} / ${formatDuration(video.duration)}`;
        }
    });
    video.addEventListener('loadedmetadata', () => {
        timeLabel.textContent = `0:00 / ${formatDuration(video.duration)}`;
    });

    barEl.appendChild(playBtn);
    barEl.appendChild(muteBtn);
    barEl.appendChild(seek);
    barEl.appendChild(timeLabel);
    syncPlay();
    muteBtn.textContent = video.muted ? '🔇' : '🔊';
}

function renderMedia(container, barEl, post, seekTime) {
    container.innerHTML = '';
    if (barEl) {
        barEl.innerHTML = '';
        barEl.classList.add('hidden');
    }
    if (!post) return;
    const url = `/media/${post.file_hash}`;
    const type = post.media_type;

    if (type === 'video' || type === 'gif') {
        const video = document.createElement('video');
        video.src = url;
        video.controls = false;
        video.autoplay = false;
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.preload = 'metadata';
        if (seekTime != null && seekTime > 0) {
            video.addEventListener('loadedmetadata', () => {
                try {
                    video.currentTime = Math.min(seekTime, Math.max(0, (video.duration || seekTime) - 0.05));
                } catch (_) {}
            }, { once: true });
        }
        container.appendChild(video);
        wireVideoControls(video, barEl);
    } else {
        const img = document.createElement('img');
        img.src = url;
        img.alt = post.display_name || post.original_name || '';
        container.appendChild(img);
    }
}

function renderInfo(el, post) {
    if (!post) {
        el.innerHTML = '';
        return;
    }
    const name = escapeHtml(post.display_name || post.original_name || post.file_hash);
    const dims = (post.width && post.height) ? `${post.width}×${post.height}` : '—';
    const dur = post.duration ? formatDuration(post.duration) : '';
    const type = escapeHtml(post.media_type || '');
    el.innerHTML = `
        <div><strong>${name}</strong></div>
        <div><span class="dup-type-badge">${type}</span>${formatSize(post.file_size)}</div>
        <div>${dims}${dur ? ' · ' + dur : ''}</div>
        <div>${post.created_at ? formatDate(post.created_at) : ''}</div>
        <div class="dup-id">#${post.id}</div>
    `;
}

function showReviewModal(pair) {
    currentPair = pair;
    const modal = $('dupReviewModal');
    if (!modal || !pair) return;
    modal.classList.remove('hidden');
    const meta = $('dupReviewMeta');
    if (meta) {
        const parts = [
            pair.reason || '',
            `Hamming ${pair.distance}`,
            pair.hitCount > 1 ? `${pair.hitCount} hits` : null,
            pair.aTime != null ? `A@${pair.aTime}s` : null,
            pair.bTime != null ? `B@${pair.bTime}s` : null
        ].filter(Boolean);
        meta.textContent = parts.join(' · ');
    }
    renderMedia($('dupMediaA'), $('dupPlayerA'), pair.a, pair.aTime);
    renderMedia($('dupMediaB'), $('dupPlayerB'), pair.b, pair.bTime);
    renderInfo($('dupInfoA'), pair.a);
    renderInfo($('dupInfoB'), pair.b);
}

function hideReviewModal() {
    const modal = $('dupReviewModal');
    if (modal) modal.classList.add('hidden');
    ['dupMediaA', 'dupMediaB'].forEach((id) => {
        const el = $(id);
        if (!el) return;
        el.querySelectorAll('video').forEach((v) => {
            try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) {}
        });
        el.innerHTML = '';
    });
    ['dupPlayerA', 'dupPlayerB'].forEach((id) => {
        const el = $(id);
        if (el) { el.innerHTML = ''; el.classList.add('hidden'); }
    });
    currentPair = null;
}

function setStatus(text) {
    const status = $('dupScanStatus');
    if (status) status.textContent = text || '';
}

function formatScanStatus(data) {
    if (!data) return '';
    const phase = data.phase || '';
    const processed = data.processed || 0;
    const total = data.total || 0;
    const msg = data.message || '';

    if (data.status === 'running') {
        if (phase === 'hashing' && total > 0) {
            return `${t('dupPhaseHashing') || 'Hashing'} ${processed} / ${total}`;
        }
        if (phase === 'matching') {
            return t('dupPhaseMatching') || 'Matching…';
        }
        if (phase === 'clearing') {
            return t('dupPhaseClearing') || 'Preparing…';
        }
        return msg || (t('dupStarting') || 'Starting…');
    }
    if (data.status === 'done' || data.status === 'review') {
        const n = data.pairCount || 0;
        if (n > 0) return `${t('dupFoundPairs') || 'Found'}: ${n}`;
        return t('dupNoPairs') || 'No near-duplicates found';
    }
    if (data.status === 'error') return msg || 'Error';
    return msg || '';
}

function setScanBusy(busy) {
    const scanBtn = $('dupScanBtn');
    const reviewBtn = $('dupReviewBtn');
    if (scanBtn) scanBtn.disabled = !!busy;
    if (reviewBtn) reviewBtn.disabled = !!busy;
}

function setReviewVisible(visible) {
    const reviewBtn = $('dupReviewBtn');
    if (!reviewBtn) return;
    reviewBtn.classList.toggle('hidden', !visible);
}

async function pollStatus() {
    try {
        const res = await fetch('/api/duplicates/status');
        const data = await readJsonResponse(res);
        if (!data.success) return;

        setStatus(formatScanStatus(data));
        const pairs = data.pairCount || 0;

        if (data.status === 'running') {
            setScanBusy(true);
            setReviewVisible(false);
            return;
        }

        setScanBusy(false);
        if (data.status === 'done' || data.status === 'review') {
            stopPoll();
            setStatus(formatScanStatus(data));
            setReviewVisible(pairs > 0);
        } else if (data.status === 'error') {
            stopPoll();
            setStatus(data.message || 'Error');
            setReviewVisible(false);
            showToast(data.message || 'Scan error', 'error');
        } else if (data.status === 'idle') {
            stopPoll();
            setReviewVisible(pairs > 0);
        }
    } catch (err) {
        console.error(err);
    }
}

function startPoll() {
    stopPoll();
    pollTimer = setInterval(pollStatus, 700);
    pollStatus();
}

function stopPoll() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

async function readJsonResponse(res) {
    const text = await res.text();
    const trimmed = (text || '').trim();
    if (!trimmed) {
        throw new Error(`Empty response (HTTP ${res.status}). Is the server route registered?`);
    }
    try {
        return JSON.parse(trimmed);
    } catch {
        const snippet = trimmed.slice(0, 120).replace(/\s+/g, ' ');
        throw new Error(
            `Server returned non-JSON (HTTP ${res.status}): ${snippet}. ` +
            `Check that server routes are installed and npm was restarted.`
        );
    }
}

async function startScan() {
    const opts = scanOptionsFromForm();
    setScanBusy(true);
    setStatus(t('dupStarting') || 'Starting…');
    try {
        const res = await fetch('/api/duplicates/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(opts)
        });
        const data = await readJsonResponse(res);
        if (!data.success) {
            showToast(data.error || 'Failed', 'error');
            setStatus(data.error || '');
            setScanBusy(false);
            return;
        }
        startPoll();
    } catch (err) {
        console.error(err);
        showToast(err.message, 'error');
        setStatus(err.message);
        setScanBusy(false);
    }
}

async function startReview() {
    const opts = scanOptionsFromForm();
    try {
        const res = await fetch('/api/duplicates/review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(opts)
        });
        const data = await readJsonResponse(res);
        if (!data.success) {
            showToast(data.error || 'Failed', 'error');
            return;
        }
        if (data.pair) {
            showReviewModal(data.pair);
            setStatus(data.message || '');
            setReviewVisible(true);
        } else {
            setStatus(data.message || (t('dupNoPairs') || 'No near-duplicates found'));
            setReviewVisible(false);
            showToast(data.message || (t('dupNoPairs') || 'No pairs'), 'info');
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function resolve(action, deleteId) {
    try {
        const res = await fetch('/api/duplicates/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, deleteId })
        });
        const data = await readJsonResponse(res);
        if (!data.success) {
            showToast(data.error || 'Failed', 'error');
            return;
        }
        if (data.done || !data.next) {
            hideReviewModal();
            setStatus(t('dupDone') || 'Review finished');
            setReviewVisible(false);
            showToast(t('dupDone') || 'Review finished', 'success');
        } else {
            showReviewModal(data.next);
            const left = (data.pairCount || 0) - (data.pairIndex || 0);
            setStatus(`${t('dupPairsLeft') || 'Left'}: ${left}`);
            setReviewVisible(left > 0);
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function bindDupSubtabs() {
    const tabs = document.querySelectorAll('.dup-subtab');
    if (!tabs.length) return;
    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            const name = tab.getAttribute('data-dup-tab');
            tabs.forEach((t) => t.classList.toggle('active', t === tab));
            document.querySelectorAll('.dup-subpanel').forEach((panel) => {
                const id = panel.id || '';
                const map = {
                    general: 'dupPanelGeneral',
                    images: 'dupPanelImages',
                    video: 'dupPanelVideo',
                    cross: 'dupPanelCross'
                };
                panel.classList.toggle('active', id === map[name]);
            });
        });
    });
}

export function bindDuplicatesUi() {
    bindDupSubtabs();
    setReviewVisible(false);
    pollStatus();

    const scanBtn = $('dupScanBtn');
    if (scanBtn) scanBtn.addEventListener('click', startScan);

    const reviewBtn = $('dupReviewBtn');
    if (reviewBtn) reviewBtn.addEventListener('click', startReview);

    const skipBtn = $('dupSkipBtn');
    if (skipBtn) skipBtn.addEventListener('click', () => resolve('skip'));

    document.querySelectorAll('.dup-delete-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (!currentPair) return;
            const side = btn.getAttribute('data-side');
            const id = side === 'a' ? currentPair.a.id : currentPair.b.id;
            resolve('delete', id);
        });
    });

    const closeBtn = $('dupReviewClose');
    if (closeBtn) closeBtn.addEventListener('click', () => hideReviewModal());
    const overlay = $('dupReviewOverlay');
    if (overlay) overlay.addEventListener('click', () => hideReviewModal());
}
