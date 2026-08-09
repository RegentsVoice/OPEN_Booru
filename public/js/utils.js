import { getLanguage, t } from './user-locales.js';

export function updateAllTexts() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (key) el.textContent = t(key);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (key) el.placeholder = t(key);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        if (key) el.title = t(key);
    });
}

export function applyLanguage() {
    const lang = getLanguage();
    document.documentElement.lang = lang;
    const languageSelect = document.getElementById('languageSelect');
    if (languageSelect) languageSelect.value = lang;
    updateAllTexts();
    if (typeof window.__refreshAfterLanguage === 'function') {
        window.__refreshAfterLanguage();
    }
}

export function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, m => {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

export function formatDate(ts) {
    if (!ts) return '?';
    return new Date(ts).toLocaleString(getLanguage() === 'ru' ? 'ru-RU' : 'en-US', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

export function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const size = (bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1);
    return size + ' ' + sizes[i];
}

export function formatDuration(seconds) {
    if (!seconds || seconds < 0) return '';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function parseTagsToArray(tagsString) {
    if (!tagsString.trim()) return [];
    return tagsString.trim().split(/\s+/).filter(t => t);
}

export const META_FILTER_OPS = [
    'type:image',
    'type:img',
    'type:video',
    'type:gif',
    'type:animation',
    'fav:true',
    'fav:only',
    'sort:newest',
    'sort:new',
    'sort:oldest',
    'sort:old',
    'sort:random',
    'sort:duration_max',
    'sort:duration_min'
];

export function isMetaFilterToken(token) {
    if (!token || !token.includes(':')) return false;
    const lower = String(token).toLowerCase();
    return META_FILTER_OPS.some(op => op === lower);
}

export function mergeFilterToken(list, token) {
    if (!token) return list.slice();
    const raw = String(token).trim();
    if (!raw) return list.slice();
    let next = list.slice();
    const lower = raw.toLowerCase();
    if (lower.includes(':')) {
        const key = lower.split(':')[0];
        next = next.filter(t => !String(t).toLowerCase().startsWith(key + ':'));
        const canonical = META_FILTER_OPS.find(op => op === lower) || raw;
        next.push(canonical);
        return next;
    }
    const bare = raw.startsWith('-') ? raw.slice(1) : raw;
    if (!bare) return next;
    next = next.filter(t => t !== bare && t !== `-${bare}`);
    next.push(raw.startsWith('-') ? `-${bare}` : bare);
    return next;
}

export function toggleExcludeToken(list, tagName) {
    const bare = String(tagName || '').replace(/^-/, '').trim();
    if (!bare) return list.slice();
    const hasPos = list.includes(bare);
    const hasNeg = list.includes(`-${bare}`);
    let next = list.filter(t => t !== bare && t !== `-${bare}`);
    if (hasPos || (!hasPos && !hasNeg)) {
        next.push(`-${bare}`);
    } else {
        next.push(bare);
    }
    return next;
}

export function showLoading() {
    document.getElementById('loadingOverlay').classList.remove('hidden');
}

export function hideLoading() {
    document.getElementById('loadingOverlay').classList.add('hidden');
}

export function showCustomDialog(title, message, buttons) {
    return new Promise((resolve) => {
        const modalElement = document.getElementById('customModal');
        const modalTitle = document.getElementById('modalTitle');
        const modalMessage = document.getElementById('modalMessage');
        const modalButtons = document.getElementById('modalButtons');
        modalTitle.textContent = title;
        modalMessage.textContent = message;
        modalButtons.innerHTML = '';
        buttons.forEach((btn) => {
            const button = document.createElement('button');
            button.textContent = btn.label;
            button.className = btn.className || 'btn-secondary';
            button.addEventListener('click', () => {
                closeModal();
                resolve(btn.value);
            });
            modalButtons.appendChild(button);
        });
        modalElement.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    });
}

export function closeModal() {
    document.getElementById('customModal').classList.add('hidden');
    document.body.style.overflow = '';
}

export function showAlert(message, title = t('error')) {
    return showCustomDialog(title, message, [
        { label: 'OK', value: true, className: 'btn-primary' }
    ]);
}

export function showConfirm(message, title = t('confirmDeletion'), opts = {}) {
    const confirmLabel = opts.confirmLabel || t('delete');
    const confirmClass = opts.confirmClass || 'btn-danger';
    return showCustomDialog(title, message, [
        { label: t('cancel'), value: false, className: 'btn-secondary' },
        { label: confirmLabel, value: true, className: confirmClass }
    ]);
}
