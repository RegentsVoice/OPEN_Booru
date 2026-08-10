import { showToast } from './toast.js';
import { state } from './state.js';
import { t } from './user-locales.js';
import { escapeHtml, formatDate } from './utils.js';

let currentPair = null;
let reviewPairs = [];
let reviewPairIndex = -1;
let reviewPage = 0;
function reviewPageSize() {
    const lim = parseInt(state && state.limit, 10);
    const base = Number.isFinite(lim) && lim > 0 ? lim : 27;
    return Math.max(1, Math.floor(base / 2));
}
let reviewSessionOpts = null;

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
        crossTypeCosine: parseFloat(($('dupCrossCosine') || {}).value) || 0.93,
        sameTypeOnly: !!(($('dupSameTypeOnly') || {}).checked),
        threshold: parseInt(($('dupThreshold') || {}).value, 10) || 5,
        concurrency: parseInt(($('dupConcurrency') || {}).value, 10) || 4,
        intervalSec: parseFloat(($('dupInterval') || {}).value) || 1,
        minVideoHits: parseInt(($('dupMinHits') || {}).value, 10) || 4,
        minGifHits: parseInt(($('dupMinGifHits') || {}).value, 10) || 2,
        minImageVideoHits: parseInt(($('dupMinImageVideoHits') || {}).value, 10) || 2,
        minGifVideoHits: parseInt(($('dupMinGifVideoHits') || {}).value, 10) || 2
    };
}

function reviewOptionsFromForm() {
    const base = scanOptionsFromForm();
    return {
        ...base,
        cosineThreshold: parseFloat(($('reviewCosine') || {}).value) || base.cosineThreshold,
        crossTypeCosine: parseFloat(($('reviewCrossCosine') || {}).value) || base.crossTypeCosine,
        threshold: parseInt(($('reviewThreshold') || {}).value, 10) || base.threshold,
        minVideoHits: parseInt(($('reviewMinHits') || {}).value, 10) || base.minVideoHits,
        minGifHits: parseInt(($('reviewMinGifHits') || {}).value, 10) || base.minGifHits
    };
}

function fillReviewParamsFromSession() {
    const src = reviewSessionOpts || scanOptionsFromForm();
    const map = {
        reviewCosine: src.cosineThreshold,
        reviewCrossCosine: src.crossTypeCosine,
        reviewThreshold: src.threshold,
        reviewMinHits: src.minVideoHits,
        reviewMinGifHits: src.minGifHits
    };
    for (const [id, val] of Object.entries(map)) {
        const el = $(id);
        if (el && val != null) el.value = val;
    }
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

    if (type === 'video') {
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
        img.loading = 'eager';
        container.appendChild(img);
        if (barEl) {
            barEl.innerHTML = '';
            barEl.classList.add('hidden');
        }
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

function posterUrl(post) {
    if (!post || !post.file_hash) return '';
    const t = post.created_at || '';
    return `/poster/${post.file_hash}${t ? `?t=${encodeURIComponent(t)}` : ''}`;
}

function mediaUrl(post) {
    if (!post || !post.file_hash) return '';
    return `/media/${post.file_hash}`;
}

function renderPairThumb(post) {
    if (!post) return '<div class="dup-pair-thumb-empty"></div>';
    const type = post.media_type || '';
    if (type === 'video' || type === 'gif') {
        const p = posterUrl(post);
        const fallback = mediaUrl(post);
        return `<img src="${p}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'" />`;
    }
    return `<img src="${mediaUrl(post)}" alt="" loading="lazy" />`;
}

function renderPairsGallery(pairs, resetPage = true) {
    const grid = $('dupPairsGallery');
    const empty = $('dupPairsEmpty');
    const pager = $('dupPairsPager');
    if (!grid) return;
    if (Array.isArray(pairs)) reviewPairs = pairs;
    if (resetPage) reviewPage = 0;

    const pageSize = reviewPageSize();

    if (!reviewPairs.length) {
        grid.innerHTML = '';
        if (empty) empty.classList.remove('hidden');
        if (pager) pager.classList.add('hidden');
        return;
    }
    if (empty) empty.classList.add('hidden');

    const totalPages = Math.max(1, Math.ceil(reviewPairs.length / pageSize));
    if (reviewPage >= totalPages) reviewPage = totalPages - 1;
    if (reviewPage < 0) reviewPage = 0;
    const start = reviewPage * pageSize;
    const slice = reviewPairs.slice(start, start + pageSize);

    grid.innerHTML = slice.map((pair, i) => {
        const idx = start + i;
        const sim = pair.similarity != null
            ? (pair.similarity * 100).toFixed(1) + '%'
            : (pair.distance != null ? String(pair.distance) : '—');
        const typeA = escapeHtml((pair.a && pair.a.media_type) || '');
        const typeB = escapeHtml((pair.b && pair.b.media_type) || '');
        return `<div class="dup-pair-card" role="button" tabindex="0" data-pair-idx="${idx}">
            <div class="dup-pair-thumbs">
                ${renderPairThumb(pair.a)}
                ${renderPairThumb(pair.b)}
            </div>
            <div class="dup-pair-meta">
                <span>${typeA} · ${typeB}</span>
                <span class="dup-pair-sim">${sim}</span>
            </div>
        </div>`;
    }).join('');

    if (!grid._pairClickBound) {
        grid._pairClickBound = true;
        grid.addEventListener('click', (e) => {
            const card = e.target.closest('.dup-pair-card');
            if (!card || !grid.contains(card)) return;
            e.preventDefault();
            e.stopPropagation();
            const idx = parseInt(card.getAttribute('data-pair-idx'), 10);
            if (!isNaN(idx)) openPairCompare(idx);
        });
        grid.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const card = e.target.closest('.dup-pair-card');
            if (!card) return;
            e.preventDefault();
            const idx = parseInt(card.getAttribute('data-pair-idx'), 10);
            if (!isNaN(idx)) openPairCompare(idx);
        });
    }

    if (pager) {
        if (totalPages > 1) {
            pager.classList.remove('hidden');
            updateDupPagination(totalPages);
        } else {
            pager.classList.add('hidden');
        }
    }
}

function updateDupPagination(totalPages) {
    const pagesEl = $('dupPairsPageInfo');
    const prev = $('dupPairsPrev');
    const next = $('dupPairsNext');
    if (prev) prev.disabled = reviewPage <= 0;
    if (next) next.disabled = reviewPage >= totalPages - 1;
    if (!pagesEl) return;

    const page = reviewPage;
    const maxVisible = 7;
    let startPage = Math.max(0, page - Math.floor(maxVisible / 2));
    let endPage = Math.min(totalPages - 1, startPage + maxVisible - 1);
    if (endPage - startPage < maxVisible - 1) startPage = Math.max(0, endPage - maxVisible + 1);
    const parts = [];
    if (startPage > 0) {
        parts.push(`<button type="button" class="page-number dup-page-number" data-page="0">1</button>`);
        if (startPage > 1) parts.push(`<span class="page-indicator">...</span>`);
    }
    for (let i = startPage; i <= endPage; i++) {
        parts.push(`<button type="button" class="page-number dup-page-number ${i === page ? 'active' : ''}" data-page="${i}">${i + 1}</button>`);
    }
    if (endPage < totalPages - 1) {
        if (endPage < totalPages - 2) parts.push(`<span class="page-indicator">...</span>`);
        parts.push(`<button type="button" class="page-number dup-page-number" data-page="${totalPages - 1}">${totalPages}</button>`);
    }
    pagesEl.innerHTML = parts.join('');
    pagesEl.querySelectorAll('.dup-page-number').forEach((btn) => {
        btn.addEventListener('click', () => {
            const newPage = parseInt(btn.getAttribute('data-page'), 10);
            if (!isNaN(newPage) && newPage !== reviewPage) {
                reviewPage = newPage;
                renderPairsGallery(null, false);
            }
        });
    });
}

function showCompareModal(pair) {
    if (!pair) return;
    currentPair = pair;
    const modal = $('dupCompareModal');
    if (!modal) {
        console.error('dupCompareModal missing');
        return;
    }
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    const meta = $('dupCompareMeta');
    if (meta) {
        const parts = [
            pair.reason || '',
            pair.similarity != null ? `sim ${pair.similarity.toFixed(3)}` : null,
            pair.hitCount > 1 ? `${pair.hitCount} hits` : null
        ].filter(Boolean);
        meta.textContent = parts.join(' · ');
    }
    renderMedia($('dupMediaA'), $('dupPlayerA'), pair.a, pair.aTime);
    renderMedia($('dupMediaB'), $('dupPlayerB'), pair.b, pair.bTime);
    renderInfo($('dupInfoA'), pair.a);
    renderInfo($('dupInfoB'), pair.b);
}

function openPairCompare(idx) {
    if (idx < 0 || idx >= reviewPairs.length) return;
    reviewPairIndex = idx;
    showCompareModal(reviewPairs[idx]);
}

function hideCompareModal() {
    const modal = $('dupCompareModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = '';
    }
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

function hideReviewModal() {
    hideCompareModal();
    const modal = $('dupReviewModal');
    if (modal) modal.classList.add('hidden');
    const grid = $('dupPairsGallery');
    if (grid) grid.innerHTML = '';
    reviewPairs = [];
    reviewPairIndex = -1;
    reviewPage = 0;
}

function setStatus(text) {
    const status = $('dupScanStatus');
    if (status) status.textContent = text || '';
}


let pollTimer = null;

async function readJsonResponse(res) {
    const text = await res.text();
    const trimmed = (text || '').trim();
    if (!trimmed) throw new Error(`Empty response (HTTP ${res.status})`);
    try {
        return JSON.parse(trimmed);
    } catch {
        const snippet = trimmed.slice(0, 120).replace(/\s+/g, ' ');
        throw new Error(`Server returned non-JSON (HTTP ${res.status}): ${snippet}`);
    }
}

function formatScanStatus(data) {
    if (!data) return '';
    const phase = data.phase || '';
    const processed = data.processed || 0;
    const total = data.total || 0;
    const msg = data.message || '';
    if (data.status === 'running') {
        if (phase === 'clearing') return t('dupPhaseClearing') || 'Clearing…';
        if (phase === 'hashing') {
            if (total > 0) return `${t('dupPhaseHashing') || 'Hashing'} ${processed} / ${total}`;
            return t('dupPhaseHashing') || 'Hashing…';
        }
        if (phase === 'matching') return t('dupPhaseMatching') || 'Matching…';
        if (phase === 'loading_model') return t('dupPhaseLoadingModel') || 'Loading model…';
        return t('dupStarting') || 'Starting…';
    }
    if (data.status === 'done' || data.status === 'review') {
        const n = data.pairCount || 0;
        if (n > 0) return `${t('dupFoundPairs') || 'Pairs'}: ${n}`;
        return t('dupNoPairs') || 'No pairs';
    }
    if (data.status === 'error') return msg || t('error') || 'Error';
    return '';
}

function setScanBusy(busy) {
    const scanBtn = $('dupScanBtn');
    if (scanBtn) scanBtn.disabled = !!busy;
    const reviewBtn = $('dupReviewBtn');
    if (reviewBtn && busy) reviewBtn.disabled = true;
    if (reviewBtn && !busy) {
        reviewBtn.disabled = false;
        reviewBtn.classList.remove('hidden');
    }
}

function setReviewVisible() {
    const reviewBtn = $('dupReviewBtn');
    if (!reviewBtn) return;
    reviewBtn.classList.remove('hidden');
    reviewBtn.disabled = false;
}

function stopPoll() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

function startPoll() {
    stopPoll();
    pollTimer = setInterval(pollStatus, 700);
    pollStatus();
}

async function pollStatus() {
    try {
        const res = await fetch('/api/duplicates/status');
        const data = await readJsonResponse(res);
        if (!data.success) return;
        setStatus(formatScanStatus(data));
        if (data.status === 'running') {
            setScanBusy(true);
            return;
        }
        setScanBusy(false);
        if (data.status === 'done' || data.status === 'review' || data.status === 'idle' || data.status === 'error') {
            stopPoll();
            if (data.status === 'error') showToast(data.message || 'Scan error', 'error');
            await refreshReviewAvailability();
        }
    } catch (err) {
        console.error(err);
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

async function waitReviewReady(maxMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        const res = await fetch('/api/duplicates/status');
        const st = await res.json();
        if (!st.success) throw new Error(st.error || 'Status failed');
        if (st.status === 'running' || st.phase === 'matching' || st.phase === 'loading') {
            const meta = $('dupReviewMeta');
            if (meta) meta.textContent = st.message || (t('dupPhaseMatching') || 'Matching…');
            await new Promise((r) => setTimeout(r, 350));
            continue;
        }
        return st;
    }
    throw new Error('Matching timeout');
}

async function fetchPairsList() {
    const res = await fetch('/api/duplicates/pairs');
    const data = await readJsonResponse(res);
    if (!data.success) throw new Error(data.error || 'Failed to load pairs');
    return data.pairs || [];
}

async function startReview(optsOverride) {
    const opts = optsOverride || reviewSessionOpts || scanOptionsFromForm();
    reviewSessionOpts = { ...opts };

    const modal = $('dupReviewModal');
    if (modal) modal.classList.remove('hidden');
        setReviewModalTab();
    const meta = $('dupReviewMeta');
    if (meta) meta.textContent = '';
    const grid = $('dupPairsGallery');
    if (grid) grid.innerHTML = '';

    const reviewBtn = $('dupReviewBtn');
    if (reviewBtn) reviewBtn.disabled = true;
    try {
        const pairs = await fetchPairsList();
        renderPairsGallery(pairs);
        if (meta) {
            meta.textContent = pairs.length
                ? `${pairs.length} ${(t('dupFoundPairs') || 'pairs')}`
                : (t('dupNoPairs') || 'No near-duplicates found');
        }
        setStatus(meta ? meta.textContent : '');
        setReviewModalTab();
        if (!pairs.length) {
            showToast(t('dupNoPairs') || 'No pairs', 'info');
        }
    } catch (err) {
        if (meta) meta.textContent = err.message || String(err);
        showToast(err.message, 'error');
    } finally {
        await refreshReviewAvailability();
    }
}

function setReviewModalTab() {
    const g = $('dupReviewPanelGallery');
    if (g) {
        g.classList.remove('hidden');
        g.classList.add('active');
    }
}

async function resolve(action, deleteId) {
    try {
        const res = await fetch('/api/duplicates/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action,
                deleteId,
                aId: currentPair && currentPair.a ? currentPair.a.id : undefined,
                bId: currentPair && currentPair.b ? currentPair.b.id : undefined
            })
        });
        const data = await readJsonResponse(res);
        if (!data.success) {
            showToast(data.error || 'Failed', 'error');
            return;
        }
        if (reviewPairIndex >= 0 && reviewPairIndex < reviewPairs.length) {
            reviewPairs.splice(reviewPairIndex, 1);
        }
        reviewPairIndex = -1;
        hideCompareModal();
        renderPairsGallery(reviewPairs, false);
        const meta = $('dupReviewMeta');
        if (meta) meta.textContent = `${reviewPairs.length} ${(t('dupFoundPairs') || 'pairs')}`;
        setReviewModalTab();
        if (!reviewPairs.length) {
            showToast(t('dupDone') || 'Review finished', 'success');
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function bindDupSubtabs() {
    const tabs = document.querySelectorAll('#dupSubtabs .dup-subtab');
    if (!tabs.length) return;
    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            const name = tab.getAttribute('data-dup-tab');
            tabs.forEach((t) => t.classList.toggle('active', t === tab));
            document.querySelectorAll('#panel-duplicates .dup-subpanel').forEach((panel) => {
                panel.classList.remove('active');
            });
            const map = {
                detect: 'dupPanelDetect',
                search: 'dupPanelSearch',
                models: 'dupPanelModels'
            };
            const panel = document.getElementById(map[name] || '');
            if (panel) panel.classList.add('active');
            if (name === 'models') {
                loadClipModelsList();
                loadClipEmbedStatus();
            }
            if (name === 'search') loadClipSearchSettings();
        });
    });
}


async function loadClipModelsList() {
    const box = $('clipModelsList');
    if (!box) return;
    try {
        const res = await fetch('/api/settings/clip/models');
        const data = await res.json();
        if (!data.success) {
            box.innerHTML = `<p class="setting-hint">${escapeHtml(data.error || 'Error')}</p>`;
            return;
        }
        const activeKey = data.active || 'small';
        const activeQ = data.activeQuantized !== false;
        const labels = {
            small: t('clipModelSmall') || 'Small (ViT-B/32)',
            base16: t('clipModelBase16') || 'Medium (ViT-B/16)',
            large: t('clipModelLarge') || 'Large (ViT-L/14)'
        };
        box.innerHTML = '';
        for (const m of data.models || []) {
            const isActive = m.key === activeKey && !!m.quantized === !!activeQ;
            const row = document.createElement('div');
            row.className = 'clip-model-row';
            row.dataset.key = m.key;
            row.dataset.quantized = m.quantized ? '1' : '0';
            const variant = m.quantized
                ? (t('clipModelQuantized') || 'quantized')
                : (t('clipModelFull') || 'full');
            let badge = '';
            if (isActive) {
                badge = `<span class="clip-model-badge">${escapeHtml(t('clipModelActive') || 'active')}</span>`;
            } else if (m.installed) {
                badge = `<span class="clip-model-badge installed">${escapeHtml(t('clipModelInstalled') || 'installed')}</span>`;
            }
            const size = m.installed
                ? (m.sizeLabel || '')
                : (t('clipModelNotInstalled') || 'not installed');
            row.innerHTML = `
                <div class="clip-model-info">
                    <strong>${escapeHtml(labels[m.key] || m.key)} · ${escapeHtml(variant)} ${badge}</strong>
                    <span class="clip-model-meta">
                        ${escapeHtml(m.modelId)} · ${escapeHtml(size)}
                    </span>
                    <div class="clip-model-progress hidden">
                        <span class="clip-model-progress-text"></span>
                        <span class="clip-model-progress-hint"></span>
                    </div>
                </div>
                <div class="clip-model-actions"></div>
            `;
            const actions = row.querySelector('.clip-model-actions');
            if (!m.installed) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'viewer-btn';
                btn.textContent = t('clipModelInstall') || 'Install';
                btn.addEventListener('click', () => installClipModelUi(m.key, m.quantized, row));
                actions.appendChild(btn);
            } else {
                if (!isActive) {
                    const useBtn = document.createElement('button');
                    useBtn.type = 'button';
                    useBtn.className = 'viewer-btn';
                    useBtn.textContent = t('clipModelUse') || 'Use';
                    useBtn.addEventListener('click', () => activateClipModelUi(m.key, m.quantized, useBtn));
                    actions.appendChild(useBtn);

                    const delBtn = document.createElement('button');
                    delBtn.type = 'button';
                    delBtn.className = 'danger-btn';
                    delBtn.textContent = t('clipModelDelete') || 'Delete';
                    delBtn.addEventListener('click', () => deleteClipModelUi(m.key, m.quantized, delBtn));
                    actions.appendChild(delBtn);
                }
            }
            box.appendChild(row);
        }
    } catch (err) {
        console.error(err);
        box.innerHTML = `<p class="setting-hint">${escapeHtml(err.message)}</p>`;
    }
}

function stopRowLoading(row) {
    if (row && row._loadTimer) {
        clearInterval(row._loadTimer);
        row._loadTimer = null;
    }
    if (!row) return;
    const wrap = row.querySelector('.clip-model-progress');
    if (wrap) wrap.classList.add('hidden');
}

function startRowLoading(row) {
    if (!row) return;
    stopRowLoading(row);
    const wrap = row.querySelector('.clip-model-progress');
    const text = row.querySelector('.clip-model-progress-text');
    const hint = row.querySelector('.clip-model-progress-hint');
    if (!wrap || !text) return;
    wrap.classList.remove('hidden');
    if (hint) {
        hint.textContent = t('clipModelInstallSlow') || 'This may take a while';
    }
    const base = t('clipModelLoading') || 'Loading';
    let step = 0;
    const tick = () => {
        step = (step % 3) + 1;
        text.textContent = base + '.'.repeat(step);
    };
    tick();
    row._loadTimer = setInterval(tick, 500);
}

async function installClipModelUi(key, quantized, row) {
    const actions = row?.querySelector('.clip-model-actions');
    if (actions) actions.innerHTML = '';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'danger-btn';
    cancelBtn.textContent = t('clipModelCancel') || 'Cancel';
    let cancelled = false;
    cancelBtn.addEventListener('click', async () => {
        cancelled = true;
        cancelBtn.disabled = true;
        try {
            await fetch('/api/settings/clip/install/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, quantized: !!quantized })
            });
        } catch (_) {}
    });
    if (actions) actions.appendChild(cancelBtn);
    startRowLoading(row);
    try {
        const res = await fetch('/api/settings/clip/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, quantized: !!quantized })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Install failed');

        const poll = async () => {
            if (cancelled) {
                stopRowLoading(row);
                showToast(t('clipModelCancelled') || 'Cancelled', 'info');
                await loadClipModelsList();
                return;
            }
            const q = quantized ? '1' : '0';
            const st = await fetch(
                `/api/settings/clip/install/status?key=${encodeURIComponent(key)}&quantized=${q}`
            );
            const sj = await st.json();
            const job = sj.job;
            if (!job) {
                stopRowLoading(row);
                await loadClipModelsList();
                return;
            }
            if (job.status === 'running') {
                setTimeout(poll, 700);
                return;
            }
            stopRowLoading(row);
            if (job.status === 'cancelled') {
                showToast(t('clipModelCancelled') || 'Cancelled', 'info');
                await loadClipModelsList();
                return;
            }
            if (job.status === 'error') {
                showToast(job.error || 'Install failed', 'error');
                await loadClipModelsList();
                return;
            }
            showToast(t('clipModelInstallOk') || 'Model installed', 'success');
            await loadClipModelsList();
        };
        setTimeout(poll, 500);
    } catch (err) {
        stopRowLoading(row);
        showToast(err.message, 'error');
        await loadClipModelsList();
    }
}

async function activateClipModelUi(key, quantized, btn) {
    if (btn) btn.disabled = true;
    try {
        const res = await fetch('/api/settings/clip/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, quantized: !!quantized })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Activate failed');
        showToast(t('clipModelUseOk') || 'Model selected', 'success');
        const hint = $('clipRescanHint');
        if (hint) {
            if (data.clipChanged) hint.classList.remove('hidden');
            else hint.classList.add('hidden');
        }
        await loadClipModelsList();
        await loadClipEmbedStatus();
        await refreshReviewAvailability();
    } catch (err) {
        showToast(err.message, 'error');
        if (btn) btn.disabled = false;
    }
}

async function deleteClipModelUi(key, quantized, btn) {
    if (!confirm(t('clipModelDeleteConfirm') || 'Delete this model variant from disk?')) return;
    if (btn) btn.disabled = true;
    try {
        const q = quantized ? '1' : '0';
        const res = await fetch(
            `/api/settings/clip/models/${encodeURIComponent(key)}?quantized=${q}`,
            { method: 'DELETE' }
        );
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Delete failed');
        showToast(t('clipModelDeleteOk') || 'Model deleted', 'success');
        await loadClipModelsList();
    } catch (err) {
        showToast(err.message, 'error');
        if (btn) btn.disabled = false;
    }
}


async function loadClipEmbedStatus() {
    const el = $('clipEmbedStatus');
    const btn = $('clipRebuildBtn');
    if (!el) return;
    try {
        const res = await fetch('/api/settings/clip/embedding-status');
        const data = await res.json();
        if (!data.success) {
            el.textContent = '';
            if (btn) btn.classList.add('hidden');
            return;
        }
        const total = data.total || 0;
        const withE = data.withEmbedding || 0;
        const missing = data.missing || 0;
        if (total === 0) {
            el.textContent = t('clipEmbedNone') || 'No media yet';
            if (btn) btn.classList.add('hidden');
            return;
        }
        if (missing > 0 || data.needsRebuild) {
            el.textContent = (t('clipEmbedMissing') || 'Embeddings: {have}/{total} — recalculate required')
                .replace('{have}', String(withE))
                .replace('{total}', String(total));
            if (btn) btn.classList.remove('hidden');
        } else {
            el.textContent = (t('clipEmbedReady') || 'Embeddings ready: {have}/{total}')
                .replace('{have}', String(withE))
                .replace('{total}', String(total));
            if (btn) btn.classList.add('hidden');
        }
    } catch (err) {
        el.textContent = '';
        if (btn) btn.classList.add('hidden');
    }
}

async function rebuildClipEmbeddings() {
    const btn = $('clipRebuildBtn');
    if (btn) btn.disabled = true;
    try {
        await startScan();
        await loadClipEmbedStatus();
    } finally {
        if (btn) btn.disabled = false;
    }
}


async function refreshReviewAvailability() {
    const reviewBtn = $('dupReviewBtn');
    if (!reviewBtn) return;
    reviewBtn.classList.remove('hidden');
    try {
        let withE = 0;
        let total = 0;
        let pairCount = 0;
        try {
            const res = await fetch('/api/settings/clip/embedding-status');
            const data = await res.json();
            if (data && data.success) {
                withE = data.withEmbedding || 0;
                total = data.total || 0;
            }
        } catch (_) {}
        try {
            const res2 = await fetch('/api/duplicates/status');
            const st = await res2.json();
            if (st && st.success) {
                pairCount = st.pairCount || 0;
                if (st.status === 'running') {
                    reviewBtn.disabled = true;
                    reviewBtn.title = t('dupStarting') || 'Scan running…';
                    return;
                }
            }
        } catch (_) {}
        const ready = withE >= 2 || pairCount > 0 || total >= 2;
        reviewBtn.disabled = false;
        reviewBtn.title = ready
            ? ''
            : (t('clipEmbedMissing') || 'Scan or wait for embeddings');
    } catch (_) {
        reviewBtn.disabled = false;
        reviewBtn.classList.remove('hidden');
    }
}

async function loadClipSearchSettings() {
    try {
        const res = await fetch('/api/settings/clip/search-settings');
        const data = await res.json();
        if (!data.success) return;
        const s = $('clipSearchMin');
        const sim = $('clipSimilarMin');
        if (s && data.clipSearchMin != null) s.value = data.clipSearchMin;
        if (sim && data.clipSimilarMin != null) sim.value = data.clipSimilarMin;
    } catch (err) {
        console.error(err);
    }
}

async function saveClipSearchSettings() {
    const s = $('clipSearchMin');
    const sim = $('clipSimilarMin');
    try {
        const res = await fetch('/api/settings/clip/search-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clipSearchMin: s ? parseFloat(s.value) : undefined,
                clipSimilarMin: sim ? parseFloat(sim.value) : undefined
            })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Save failed');
        if (s && data.clipSearchMin != null) s.value = data.clipSearchMin;
        if (sim && data.clipSimilarMin != null) sim.value = data.clipSimilarMin;
        try {
            localStorage.setItem('clip_scan_opts', JSON.stringify(scanOptionsFromForm()));
        } catch (_) {}
        showToast(t('settingsSaved') || 'Saved', 'success');
    } catch (err) {
        showToast(err.message || String(err), 'error');
    }
}

function loadScanOptsFromStorage() {
    try {
        const raw = localStorage.getItem('clip_scan_opts');
        if (!raw) return;
        const o = JSON.parse(raw);
        const map = {
            dupCosine: o.cosineThreshold,
            dupCrossCosine: o.crossTypeCosine,
            dupThreshold: o.threshold,
            dupConcurrency: o.concurrency,
            dupInterval: o.intervalSec,
            dupMinHits: o.minVideoHits,
            dupMinGifHits: o.minGifHits,
            dupMinImageVideoHits: o.minImageVideoHits,
            dupMinGifVideoHits: o.minGifVideoHits
        };
        for (const [id, val] of Object.entries(map)) {
            const el = $(id);
            if (el && val != null) el.value = val;
        }
        const same = $('dupSameTypeOnly');
        if (same && o.sameTypeOnly != null) same.checked = !!o.sameTypeOnly;
    } catch (_) {}
}

export function bindDuplicatesUi() {
    bindDupSubtabs();
    loadScanOptsFromStorage();
    pollStatus();
    refreshReviewAvailability();

    const rebuildBtn = $('clipRebuildBtn');
    if (rebuildBtn) rebuildBtn.addEventListener('click', rebuildClipEmbeddings);

    const settingsSave = $('clipSettingsSave');
    if (settingsSave) settingsSave.addEventListener('click', saveClipSearchSettings);

    const scanBtn = $('dupScanBtn');
    if (scanBtn) scanBtn.addEventListener('click', startScan);

    const reviewBtn = $('dupReviewBtn');
    if (reviewBtn) reviewBtn.addEventListener('click', () => startReview());

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

    const cmpClose = $('dupCompareClose');
    if (cmpClose) cmpClose.addEventListener('click', () => hideCompareModal());
    const cmpOverlay = $('dupCompareOverlay');
    if (cmpOverlay) cmpOverlay.addEventListener('click', () => hideCompareModal());

    const prev = $('dupPairsPrev');
    if (prev) prev.addEventListener('click', () => {
        if (reviewPage > 0) {
            reviewPage -= 1;
            renderPairsGallery(null, false);
        }
    });
    const next = $('dupPairsNext');
    if (next) next.addEventListener('click', () => {
        const pages = Math.max(1, Math.ceil(reviewPairs.length / reviewPageSize()));
        if (reviewPage < pages - 1) {
            reviewPage += 1;
            renderPairsGallery(null, false);
        }
    });
}
