import { showToast } from './toast.js';
import { getLanguage, setLanguage, t } from './user-locales.js';
import { state } from './state.js';
import {
    applyLanguage, updateAllTexts, showAlert, showConfirm, escapeHtml, formatDate, parseTagsToArray,
    META_FILTER_OPS, mergeFilterToken
} from './utils.js';

function getMediaUi() {
    return import('./media-ui.js');
}

const authModal = document.getElementById('authModal');
const authError = document.getElementById('authError');
const logoutBtn = document.getElementById('logoutBtn');
const userModal = document.getElementById('userModal');
const logsContainer = document.getElementById('logsContainer');
const displayLimit = document.getElementById('displayLimit');
const displayRowHeight = document.getElementById('displayRowHeight');
const displayCardWidth = document.getElementById('displayCardWidth');
const gallery = document.getElementById('gallery');
const favoritesTabsDiv = document.getElementById('favoritesTabs');
const languageSelect = document.getElementById('languageSelect');
const accessPort = document.getElementById('accessPort');
const accessLocalhostOnly = document.getElementById('accessLocalhostOnly');
const accessRegistrationDisabled = document.getElementById('accessRegistrationDisabled');
const accessRestartHint = document.getElementById('accessRestartHint');
const newUsername = document.getElementById('newUsername');
const oldPassword = document.getElementById('oldPassword');
const newPassword = document.getElementById('newPassword');
const confirmPassword = document.getElementById('confirmPassword');
const tagInput = document.getElementById('tagInput');
const editTagsInputModal = document.getElementById('editTagsInputModal');
const uploadTagsAddInput = document.getElementById('uploadTagsAddInput');
export let selectedSuggestionIndex = -1;
export const suggestions = document.createElement('div');
suggestions.className = 'suggestions-container';
document.body.appendChild(suggestions);

export function hideSuggestions() {
    suggestions.classList.remove('show');
    selectedSuggestionIndex = -1;
}

export async function showAuthModal() {
    if (!authModal) {
        console.error('authModal element missing');
        return;
    }
    authModal.classList.remove('hidden');
    authModal.style.display = '';
    if (authError) authError.classList.add('hidden');
    try { switchAuthTab('login'); } catch (e) { console.warn(e); }
    const ids = ['authUsernameLogin','authPasswordLogin','authUsernameRegister','authPasswordRegister','authConfirmRegister'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    try { applyLanguage(); } catch (e) {}
    try {
        const disabled = await fetchRegistrationPolicy();
        await applyRegistrationPolicy(disabled);
    } catch (e) { console.warn('registration policy', e); }
}

export function hideAuthModal() {
    authModal.classList.add('hidden');
}

export function switchAuthTab(tab) {
    document.querySelectorAll('.auth-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.getElementById('authFormLogin').classList.toggle('active', tab === 'login');
    document.getElementById('authFormRegister').classList.toggle('active', tab === 'register');
    authError.classList.add('hidden');
}

document.querySelectorAll('.auth-tab').forEach(btn => {
    btn.addEventListener('click', () => {
        switchAuthTab(btn.dataset.tab);
    });
});

document.getElementById('authLoginBtn')?.addEventListener('click', async () => {
    const username = document.getElementById('authUsernameLogin').value.trim();
    const password = document.getElementById('authPasswordLogin').value;
    if (!username || !password) {
        authError.textContent = t('username_required');
        authError.classList.remove('hidden');
        return;
    }
    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (data.success) {
            hideAuthModal();
            state.authenticated = true;
            state.isAdmin = !!data.isAdmin;
            state.isOwner = !!data.isOwner;
            state.username = username;
            showToast(t('loginSuccess'), 'success');
            applyLanguage();
            void getMediaUi().then(m => m.loadMedia(0));
        } else {
            const errorMessages = {
                'username_required': t('username_required'),
                'invalid_credentials': t('invalid_credentials'),
                'internal_error': t('internal_error')
            };
            authError.textContent = errorMessages[data.code] || t('loginError');
            authError.classList.remove('hidden');
        }
    } catch (err) {
        console.error('Login error:', err);
        authError.textContent = t('networkError');
        authError.classList.remove('hidden');
    }
});

document.getElementById('authRegisterBtn')?.addEventListener('click', async () => {
    const username = document.getElementById('authUsernameRegister').value.trim();
    const password = document.getElementById('authPasswordRegister').value;
    const confirm = document.getElementById('authConfirmRegister').value;
    if (!username || !password || !confirm) {
        authError.textContent = t('username_required');
        authError.classList.remove('hidden');
        return;
    }
    if (password !== confirm) {
        authError.textContent = t('passwordsDoNotMatch');
        authError.classList.remove('hidden');
        return;
    }
    try {
        const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (data.success) {
            hideAuthModal();
            state.authenticated = true;
            state.isAdmin = !!data.isAdmin;
            state.isOwner = !!data.isOwner;
            state.username = username;
            showToast(t('registrationSuccess'), 'success');
            applyLanguage();
            void getMediaUi().then(m => m.loadMedia(0));
        } else {
            const errorMessages = {
                'username_required': t('username_required'),
                'username_exists': t('usernameExists'),
                'internal_error': t('internal_error'),
                'registration_disabled': t('registration_disabled')
            };
            authError.textContent = errorMessages[data.code] || t('registrationError');
            authError.classList.remove('hidden');
        }
    } catch (err) {
        console.error('Registration error:', err);
        authError.textContent = t('networkError');
        authError.classList.remove('hidden');
    }
});

document.querySelectorAll('#authPasswordLogin').forEach(input => {
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('authLoginBtn').click();
    });
});
document.querySelectorAll('#authUsernameRegister, #authPasswordRegister, #authConfirmRegister').forEach(input => {
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('authRegisterBtn').click();
    });
});

export async function checkAuth() {
    try {
        const res = await fetch('/api/auth/me');
        const data = await res.json();
        if (data.authenticated) {
            state.authenticated = true;
            state.isAdmin = !!data.isAdmin;
            state.isOwner = !!data.isOwner;
            state.username = data.username;
            return true;
        } else {
            state.authenticated = false;
            state.isAdmin = false;
            state.isOwner = false;
            showAuthModal();
            return false;
        }
    } catch (err) {
        console.error('Auth check error:', err);
        showAuthModal();
        return false;
    }
}

logoutBtn?.addEventListener('click', async () => {
    try {
        const res = await fetch('/api/auth/logout', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            state.authenticated = false;
            state.isAdmin = false;
            state.isOwner = false;
            state.username = '';
            closeUserModalFn();
            showAuthModal();
            gallery.innerHTML = `<div class="empty-state">${t('pleaseLogin')}</div>`;
            showToast(t('loggedOut'), 'info');
        } else {
            console.error('Logout error:', data);
            showToast(t('logoutError'), 'error');
        }
    } catch (err) {
        console.error('Logout error:', err);
        showToast(t('networkError'), 'error');
    }
});

export async function openUserModal() {
    userModal.classList.remove('hidden');
    displayLimit.value = state.limit;
    displayRowHeight.value = state.rowHeight;
    displayCardWidth.value = state.cardWidth;
    newUsername.value = state.username;
    languageSelect.value = getLanguage();

    document.querySelectorAll('.settings-tab.admin-only').forEach(tab => {
        tab.classList.toggle('hidden', !state.isAdmin);
    });

    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
    const displayTab = document.querySelector('.settings-tab[data-tab="display"]');
    if (displayTab) displayTab.classList.add('active');
    const displayPanel = document.getElementById('panel-display');
    if (displayPanel) displayPanel.classList.add('active');

    if (state.isAdmin) {
        await loadAccessSettings();
        await loadLogs();
        await loadUsersList();
    }
    applyLanguage();
}

export function closeUserModalFn() {
    userModal.classList.add('hidden');
}

export async function loadLogs() {
    try {
        const res = await fetch('/api/logs');
        const data = await res.json();

        logsContainer.textContent = (data.logs || []).join('\n\n');
    } catch (err) {
        console.error('Load logs error:', err);
        logsContainer.textContent = t('error');
    }
}

export function isMobileGallery() {
    return window.matchMedia('(max-width: 768px)').matches;
}

export function applyGalleryGridStyles() {
    if (!gallery) return;
    if (isMobileGallery()) {

        gallery.style.gridTemplateColumns = '';
        gallery.style.gridAutoRows = '';
        return;
    }
    const cardW = state.cardWidth || 220;
    const rowH = state.rowHeight || 250;
    gallery.style.gridTemplateColumns = `repeat(auto-fill, minmax(${cardW}px, 1fr))`;
    gallery.style.gridAutoRows = `${rowH}px`;
}

export function applyDisplaySettings() {
    const limit = parseInt(displayLimit.value) || 27;
    const rowH = parseInt(displayRowHeight.value) || 250;
    const cardW = parseInt(displayCardWidth.value) || 220;

    localStorage.setItem('gallery_limit', limit);
    localStorage.setItem('gallery_rowHeight', rowH);
    localStorage.setItem('gallery_cardWidth', cardW);

    state.limit = limit;
    state.rowHeight = rowH;
    state.cardWidth = cardW;

    applyGalleryGridStyles();
    void getMediaUi().then(m => m.loadMedia(state.page));
    showToast(t('displaySettingsSaved'), 'success');
}

export async function changeUsername() {
    const username = newUsername.value.trim();
    if (!username) return showToast(t('usernameRequired'), 'error');
    try {
        const res = await fetch('/api/change-username', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newUsername: username })
        });
        const data = await res.json();
        if (data.success) {
            state.username = username;
            showToast(t('usernameUpdated'), 'success');
        } else {
            console.error('Username change error:', data);
            showToast(t('usernameChangeError'), 'error');
        }
    } catch (err) {
        console.error('Username change error:', err);
        showToast(t('networkError'), 'error');
    }
}

export async function changePassword() {
    const old = oldPassword.value;
    const newPwd = newPassword.value;
    const confirm = confirmPassword.value;
    if (!old || !newPwd || !confirm) {
        return showToast(t('allFieldsRequired'), 'error');
    }
    if (newPwd !== confirm) {
        return showToast(t('passwordsDoNotMatch'), 'error');
    }
    try {
        const res = await fetch('/api/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPassword: old, newPassword: newPwd })
        });
        const data = await res.json();
        if (data.success) {
            showToast(t('passwordChanged'), 'success');
            oldPassword.value = '';
            newPassword.value = '';
            confirmPassword.value = '';
        } else {
            console.error('Password change error:', data);
            showToast(data.error || t('passwordChangeError'), 'error');
        }
    } catch (err) {
        console.error('Password change error:', err);
        showToast(t('networkError'), 'error');
    }
}

export async function loadAccessSettings() {
    try {
        const res = await fetch('/api/settings/access');
        const data = await res.json();
        if (data.success) {
            if (accessPort) accessPort.value = data.port || data.currentPort || 3001;
            if (accessLocalhostOnly) accessLocalhostOnly.checked = !!data.localhostOnly;
            if (accessRegistrationDisabled) accessRegistrationDisabled.checked = !!data.registrationDisabled;
            const serverLangSelect = document.getElementById('serverLanguageSelect');
            if (serverLangSelect && data.language) serverLangSelect.value = data.language;
            if (accessRestartHint) accessRestartHint.classList.add('hidden');
        }
    } catch (err) {
        console.error('Load access settings error:', err);
    }
}

export async function saveAccessSettings() {
    const port = parseInt(accessPort?.value, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return showToast(t('invalidPort'), 'error');
    }
    try {
        const res = await fetch('/api/settings/access', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                port,
                localhostOnly: !!accessLocalhostOnly?.checked,
                registrationDisabled: !!accessRegistrationDisabled?.checked,
                language: document.getElementById('serverLanguageSelect')?.value || undefined
            })
        });
        const data = await res.json();
        if (data.success) {
            showToast(t('accessSettingsSaved'), 'success');
            if (accessRestartHint) {
                if (data.restartRequired) accessRestartHint.classList.remove('hidden');
                else accessRestartHint.classList.add('hidden');
            }

            await applyRegistrationPolicy(data.registrationDisabled);
        } else {
            showToast(data.error || t('accessSettingsError'), 'error');
        }
    } catch (err) {
        console.error('Save access settings error:', err);
        showToast(t('networkError'), 'error');
    }
}

export async function fetchRegistrationPolicy() {
    try {
        const res = await fetch('/api/auth/public-config');
        const data = await res.json();
        return !!data.registrationDisabled;
    } catch (err) {
        console.error('Public config error:', err);
        return false;
    }
}

export async function applyRegistrationPolicy(disabled) {
    const tabs = document.querySelector('.auth-tabs');
    const registerPanel = document.getElementById('authFormRegister');
    if (disabled) {
        if (tabs) tabs.classList.add('registration-hidden');

        switchAuthTab('login');
        if (registerPanel) registerPanel.classList.remove('active');
    } else {
        if (tabs) tabs.classList.remove('registration-hidden');
    }
}

export async function saveLanguage() {
    const lang = languageSelect.value;
    setLanguage(lang);
    applyLanguage();
    showToast(t('languageSaved'), 'success');
}

export async function loadUsersList() {
    const container = document.getElementById('usersListContainer');
    if (!container) return;
    if (!state.isAdmin) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = `<p class="setting-hint">${t('loadingUsers')}</p>`;
    try {
        const res = await fetch('/api/admin/users');
        const data = await res.json();
        if (!data.success) {
            container.innerHTML = `<p class="tags-manage-empty">${t('error')}</p>`;
            return;
        }
        const users = data.users || [];
        if (!users.length) {
            container.innerHTML = `<p class="setting-hint">${t('noUsers')}</p>`;
            return;
        }
        container.innerHTML = users.map(u => {
            const dateStr = u.created_at ? formatDate(u.created_at) : '—';
            const isSelf = u.username === state.username;
            const badges = [];
            if (u.is_owner) badges.push(`<span class="user-role-badge user-owner-badge">${t('ownerBadge')}</span>`);
            else if (u.is_admin) badges.push(`<span class="user-role-badge user-admin-badge">${t('adminBadge')}</span>`);

            const actions = [];
            if (state.isOwner && !isSelf && !u.is_owner) {
                if (u.is_admin) {
                    actions.push(`<button type="button" class="viewer-btn user-demote-btn" data-user-id="${u.id}" data-username="${escapeHtml(u.username)}">${t('removeAdmin')}</button>`);
                } else {
                    actions.push(`<button type="button" class="viewer-btn user-promote-btn" data-user-id="${u.id}" data-username="${escapeHtml(u.username)}">${t('makeAdmin')}</button>`);
                }
                actions.push(`<button type="button" class="viewer-btn user-transfer-btn" data-user-id="${u.id}" data-username="${escapeHtml(u.username)}">${t('transferOwnership')}</button>`);
            }
            if (!isSelf && !u.is_owner) {
                actions.push(`<button type="button" class="viewer-btn danger-btn user-delete-btn" data-user-id="${u.id}" data-username="${escapeHtml(u.username)}">${t('delete')}</button>`);
            }

            return `<div class="user-row">
                <div class="user-row-info">
                    <div class="user-row-name">
                        <strong>${escapeHtml(u.username)}</strong>
                        ${badges.join('')}
                    </div>
                    <span class="user-row-meta">${dateStr}</span>
                </div>
                <div class="user-row-right">
                    <div class="user-row-actions">${actions.join('')}</div>
                </div>
            </div>`;
        }).join('');

        container.querySelectorAll('.user-delete-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = parseInt(btn.dataset.userId, 10);
                const name = btn.dataset.username || '';
                const ok = await showConfirm(t('confirmDeleteUser', { name }), t('confirmDeletion'), {
                    confirmLabel: t('delete'),
                    confirmClass: 'btn-danger'
                });
                if (!ok) return;
                try {
                    const delRes = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
                    const delData = await delRes.json();
                    if (delData.success) {
                        showToast(t('userDeleted'), 'success');
                        await loadUsersList();
                    } else if (delData.code === 'cannot_delete_self') {
                        showToast(t('cannotDeleteSelf'), 'error');
                    } else if (delData.code === 'cannot_delete_last_admin') {
                        showToast(t('cannotDeleteLastAdmin'), 'error');
                    } else if (delData.code === 'cannot_delete_owner') {
                        showToast(t('cannotDeleteOwner'), 'error');
                    } else {
                        showToast(delData.error || t('error'), 'error');
                    }
                } catch (err) {
                    console.error('Delete user error:', err);
                    showToast(t('networkError'), 'error');
                }
            });
        });

        container.querySelectorAll('.user-promote-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = parseInt(btn.dataset.userId, 10);
                const name = btn.dataset.username || '';
                const ok = await showConfirm(t('confirmMakeAdmin', { name }), t('makeAdmin'), {
                    confirmLabel: t('makeAdmin'),
                    confirmClass: 'btn-primary'
                });
                if (!ok) return;
                try {
                    const r = await fetch(`/api/admin/users/${id}/set-admin`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ is_admin: true })
                    });
                    const d = await r.json();
                    if (d.success) {
                        showToast(t('adminGranted'), 'success');
                        await loadUsersList();
                    } else {
                        showToast(d.error || t('error'), 'error');
                    }
                } catch (err) {
                    showToast(t('networkError'), 'error');
                }
            });
        });

        container.querySelectorAll('.user-demote-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = parseInt(btn.dataset.userId, 10);
                const name = btn.dataset.username || '';
                const ok = await showConfirm(t('confirmRemoveAdmin', { name }), t('removeAdmin'), {
                    confirmLabel: t('removeAdmin'),
                    confirmClass: 'btn-primary'
                });
                if (!ok) return;
                try {
                    const r = await fetch(`/api/admin/users/${id}/set-admin`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ is_admin: false })
                    });
                    const d = await r.json();
                    if (d.success) {
                        showToast(t('adminRevoked'), 'success');
                        await loadUsersList();
                    } else if (d.code === 'cannot_demote_owner') {
                        showToast(t('cannotDemoteOwner'), 'error');
                    } else {
                        showToast(d.error || t('error'), 'error');
                    }
                } catch (err) {
                    showToast(t('networkError'), 'error');
                }
            });
        });

        container.querySelectorAll('.user-transfer-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = parseInt(btn.dataset.userId, 10);
                const name = btn.dataset.username || '';
                const ok = await showConfirm(t('confirmTransferOwnership', { name }), t('transferOwnership'), {
                    confirmLabel: t('transferOwnership'),
                    confirmClass: 'btn-primary'
                });
                if (!ok) return;
                try {
                    const r = await fetch(`/api/admin/users/${id}/transfer-ownership`, { method: 'POST' });
                    const d = await r.json();
                    if (d.success) {
                        state.isOwner = false;

                        showToast(t('ownershipTransferred'), 'success');
                        await loadUsersList();
                    } else {
                        showToast(d.error || t('error'), 'error');
                    }
                } catch (err) {
                    showToast(t('networkError'), 'error');
                }
            });
        });
    } catch (err) {
        console.error('Load users error:', err);
        container.innerHTML = `<p class="setting-hint">${t('networkError')}</p>`;
    }
}

const BOORU_HELP = {
    gelbooru: 'https://gelbooru.com/index.php?page=account&s=options',
    rule34: 'https://rule34.xxx/index.php?page=account&s=options',
    realbooru: 'https://realbooru.com/index.php?page=account&s=options',
    xbooru: 'https://xbooru.com/index.php?page=account&s=options',
    hypnohub: 'https://hypnohub.net/index.php?page=account&s=options',
    tbib: 'https://tbib.org/index.php?page=account&s=options',
    derpibooru: 'https://derpibooru.org/registration/edit',
    furbooru: 'https://furbooru.org/registration/edit',
    ponybooru: 'https://ponybooru.org/registration/edit',
    danbooru: 'https://danbooru.donmai.us/profile',
    e621: 'https://e621.net/users/home'
};

export async function loadBooruCredentialsList() {
    const container = document.getElementById('booruCredentialsList');
    if (!container) return;
    container.innerHTML = `<p class="setting-hint">${t('loadingBooruCreds')}</p>`;
    try {
        const res = await fetch('/api/booru/credentials');
        const data = await res.json();
        if (!data.success) {
            container.innerHTML = `<p class="tags-manage-empty">${t('error')}</p>`;
            return;
        }
        const sites = data.sites || [];
        container.innerHTML = sites.map(s => {
            const status = s.configured
                ? `<span class="booru-status configured">${t('booruConfigured')}</span>`
                : (s.needsAuth
                    ? `<span class="booru-status missing">${t('booruNotConfigured')}</span>`
                    : `<span class="booru-status optional">${t('booruOptional')}</span>`);
            const acc = s.account_id || s.login || '';
            return `<div class="booru-cred-row" data-site="${escapeHtml(s.id)}">
                <div class="booru-cred-info">
                    <strong>${escapeHtml(s.name)}</strong>
                    <span class="booru-cred-meta">${status}${acc ? ' · ' + escapeHtml(acc) : ''}${s.has_api_key ? ' · ' + escapeHtml(s.api_key_masked) : ''}</span>
                </div>
                <div class="booru-cred-actions">
                    <button type="button" class="viewer-btn booru-edit-btn" data-site="${escapeHtml(s.id)}" data-name="${escapeHtml(s.name)}" data-needs-auth="${s.needsAuth ? '1' : '0'}">${t('edit')}</button>
                    ${s.configured ? `<button type="button" class="viewer-btn danger-btn booru-clear-btn" data-site="${escapeHtml(s.id)}">${t('delete')}</button>` : ''}
                </div>
            </div>`;
        }).join('');

        container.querySelectorAll('.booru-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => openBooruCredsModal(btn.dataset.site, btn.dataset.name));
        });
        container.querySelectorAll('.booru-clear-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const site = btn.dataset.site;
                const ok = await showConfirm(t('confirmClearBooruCreds'), t('confirmDeletion'), {
                    confirmLabel: t('delete'),
                    confirmClass: 'btn-danger'
                });
                if (!ok) return;
                try {
                    await fetch(`/api/booru/credentials/${encodeURIComponent(site)}`, { method: 'DELETE' });
                    showToast(t('booruCredsCleared'), 'success');
                    await loadBooruCredentialsList();
                } catch (e) {
                    showToast(t('networkError'), 'error');
                }
            });
        });
    } catch (err) {
        console.error('Load booru creds error:', err);
        container.innerHTML = `<p class="setting-hint">${t('networkError')}</p>`;
    }
}

let _booruCredsResolve = null;

export function openBooruCredsModal(site, siteName) {
    return new Promise((resolve) => {
        _booruCredsResolve = resolve;
        const modal = document.getElementById('booruCredsModal');
        if (!modal) { resolve(false); return; }
        document.getElementById('booruCredsSite').value = site || '';
        const title = document.getElementById('booruCredsModalTitle');
        if (title) title.textContent = t('booruCredsTitle') + (siteName ? `: ${siteName}` : (site ? `: ${site}` : ''));
        const help = document.getElementById('booruCredsHelp');
        const link = BOORU_HELP[site];
        if (help) {
            help.innerHTML = link
                ? `${t('booruCredsGetKey')} <a href="${link}" target="_blank" rel="noopener">${link}</a>`
                : t('booruCredsHint');
        }
        const accountLabel = document.getElementById('booruCredsAccountLabel');
        if (accountLabel) {
            accountLabel.textContent = (site === 'danbooru' || site === 'e621') ? t('booruLogin') : t('booruUserId');
        }
        document.getElementById('booruCredsAccountId').value = '';
        document.getElementById('booruCredsApiKey').value = '';
        modal.classList.remove('hidden');
        applyLanguage();
    });
}

export function closeBooruCredsModal(saved = false) {
    const modal = document.getElementById('booruCredsModal');
    if (modal) modal.classList.add('hidden');
    if (_booruCredsResolve) {
        _booruCredsResolve(!!saved);
        _booruCredsResolve = null;
    }
}

export async function saveBooruCredsFromModal(force = false) {
    const site = document.getElementById('booruCredsSite')?.value;
    const account_id = document.getElementById('booruCredsAccountId')?.value?.trim() || '';
    const api_key = document.getElementById('booruCredsApiKey')?.value?.trim() || '';
    const statusEl = document.getElementById('booruCredsStatus');
    const saveBtn = document.getElementById('saveBooruCredsBtn');
    if (!site) return;
    if (!api_key || !account_id) {
        showToast(t('booruCredsRequired'), 'error');
        return;
    }
    if (statusEl) {
        statusEl.className = 'setting-hint checking';
        statusEl.textContent = force ? (t('booruSaving') || 'Saving…') : t('booruVerifying');
    }
    if (saveBtn) saveBtn.disabled = true;
    try {
        const res = await fetch('/api/booru/credentials', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                site,
                account_id,
                login: account_id,
                api_key,
                skip_verify: !!force
            })
        });
        const data = await res.json();
        if (!data.success) {
            if (data.code === 'verify_inconclusive' || data.inconclusive) {
                if (statusEl) {
                    statusEl.className = 'setting-hint fail';
                    statusEl.textContent = (t('booruVerifyInconclusive') || 'Could not verify from server') + (data.error ? `: ${data.error}` : '');
                }
                const ok = await showConfirm(
                    (t('booruVerifyInconclusiveConfirm') || 'Verification failed (often site blocks server IP). Save credentials anyway?'),
                    t('booruCredsTitle') || 'Booru',
                    { confirmLabel: t('save') || t('confirm') || 'OK', confirmClass: 'btn-primary' }
                );
                if (ok) {
                    return saveBooruCredsFromModal(true);
                }
                return;
            }
            if (statusEl) {
                statusEl.className = 'setting-hint fail';
                statusEl.textContent = (t('booruVerifyFail') || 'Verification failed') + (data.error ? `: ${data.error}` : '');
            }
            showToast((t('booruVerifyFail') || data.error || t('error')), 'error');
            return;
        }
        if (statusEl) {
            statusEl.className = 'setting-hint ok';
            statusEl.textContent = force ? (t('booruCredsSaved') || 'Saved') : t('booruVerifyOk');
        }
        showToast(t('booruCredsSaved'), 'success');
        closeBooruCredsModal(true);
        await loadBooruCredentialsList();
    } catch (err) {
        if (statusEl) {
            statusEl.className = 'setting-hint fail';
            statusEl.textContent = t('booruVerifyFail');
        }
        showToast(t('networkError'), 'error');
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

let _tagsSearchTimer = null;

export async function loadTagsList(search = '') {
    const container = document.getElementById('tagsManageList');
    if (!container) return;
    container.innerHTML = `<p class="tags-manage-empty">${t('loadingTags') || 'Loading…'}</p>`;
    try {
        const q = search != null ? search : (document.getElementById('tagsManageSearch')?.value || '');
        const url = '/api/tags?limit=1000' + (q ? `&q=${encodeURIComponent(q)}` : '');
        const res = await fetch(url);
        const data = await res.json();
        if (!data.success) {
            container.innerHTML = `<p class="tags-manage-empty">${t('error')}</p>`;
            return;
        }
        const tags = data.tags || [];
        if (!tags.length) {
            container.innerHTML = `<p class="tags-manage-empty">${t('noTags')}</p>`;
            return;
        }
        container.innerHTML = tags.map(tag => `
            <div class="tag-manage-row" data-id="${tag.id}">
                <span class="tag-name">${escapeHtml(tag.name)}</span>
                <span class="tag-count">${tag.count}</span>
                <div class="tag-manage-actions">
                    <button type="button" class="viewer-btn tag-edit-btn" data-id="${tag.id}" data-name="${escapeHtml(tag.name)}">${t('edit')}</button>
                    <button type="button" class="viewer-btn danger-btn tag-del-btn" data-id="${tag.id}" data-name="${escapeHtml(tag.name)}">${t('delete')}</button>
                </div>
            </div>
        `).join('');

        container.querySelectorAll('.tag-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => startTagInlineEdit(btn.closest('.tag-manage-row'), btn.dataset.id, btn.dataset.name));
        });
        container.querySelectorAll('.tag-del-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const ok = await showConfirm(
                    (t('confirmDeleteTag') || 'Delete tag "{name}"?').replace('{name}', btn.dataset.name),
                    t('confirmDeletion') || 'Confirm',
                    { confirmLabel: t('delete'), confirmClass: 'btn-danger' }
                );
                if (!ok) return;
                try {
                    const r = await fetch(`/api/tags/${btn.dataset.id}`, { method: 'DELETE' });
                    const d = await r.json();
                    if (!d.success) throw new Error(d.error || 'fail');
                    showToast(t('tagDeleted') || 'Tag deleted', 'success');
                    await loadTagsList();
                } catch (e) {
                    showToast(t('networkError'), 'error');
                }
            });
        });
    } catch (err) {
        console.error(err);
        container.innerHTML = `<p class="setting-hint">${t('networkError')}</p>`;
    }
}

function startTagInlineEdit(row, id, name) {
    if (!row) return;
    row.innerHTML = `
        <input type="text" class="tag-edit-input" value="${escapeHtml(name)}" />
        <div class="tag-manage-actions">
            <button type="button" class="viewer-btn primary-btn tag-save-btn">${t('save')}</button>
            <button type="button" class="viewer-btn tag-cancel-btn">${t('cancel')}</button>
        </div>
    `;
    const input = row.querySelector('.tag-edit-input');
    input.focus();
    input.select();
    const save = async () => {
        const newName = input.value.trim();
        if (!newName || newName === name) {
            await loadTagsList(document.getElementById('tagsManageSearch')?.value || '');
            return;
        }
        try {
            const r = await fetch(`/api/tags/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName })
            });
            const d = await r.json();
            if (!d.success) throw new Error(d.error || 'fail');
            showToast(d.merged ? (t('tagMerged') || 'Tag merged') : (t('tagRenamed') || 'Tag renamed'), 'success');
            await loadTagsList(document.getElementById('tagsManageSearch')?.value || '');
        } catch (e) {
            showToast(e.message || t('networkError'), 'error');
        }
    };
    row.querySelector('.tag-save-btn').addEventListener('click', save);
    row.querySelector('.tag-cancel-btn').addEventListener('click', () => loadTagsList(document.getElementById('tagsManageSearch')?.value || ''));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        if (e.key === 'Escape') loadTagsList(document.getElementById('tagsManageSearch')?.value || '');
    });
}

export function bindTagsManageEvents() {
    const search = document.getElementById('tagsManageSearch');
    if (search) {
        search.addEventListener('input', () => {
            clearTimeout(_tagsSearchTimer);
            _tagsSearchTimer = setTimeout(() => loadTagsList(search.value), 250);
        });
    }
    const refresh = document.getElementById('refreshTagsListBtn');
    if (refresh) refresh.addEventListener('click', () => loadTagsList(document.getElementById('tagsManageSearch')?.value || ''));
}

export function bindBooruSettingsEvents() {
    const refresh = document.getElementById('refreshBooruCredsBtn');
    if (refresh) refresh.addEventListener('click', loadBooruCredentialsList);
    const saveBtn = document.getElementById('saveBooruCredsBtn');
    if (saveBtn) saveBtn.addEventListener('click', saveBooruCredsFromModal);
    const cancelBtn = document.getElementById('cancelBooruCredsBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => closeBooruCredsModal(false));
    const closeBtn = document.getElementById('closeBooruCredsModal');
    if (closeBtn) closeBtn.addEventListener('click', () => closeBooruCredsModal(false));
    const modal = document.getElementById('booruCredsModal');
    if (modal) {
        modal.querySelector('.modal-overlay')?.addEventListener('click', () => closeBooruCredsModal(false));
    }
}

suggestions.className = 'suggestions-container';
document.body.appendChild(suggestions);

export function renderSuggestions(inputElement, tags, opts = {}) {
    suggestions.innerHTML = '';
    selectedSuggestionIndex = -1;
    const list = Array.isArray(tags) ? tags.slice() : [];
    const isSearch = inputElement && inputElement.id === 'tagInput';
    const prefix = String(opts.query || '').trim().toLowerCase();
    const excludePrefix = prefix.startsWith('-');
    const matchQ = excludePrefix ? prefix.slice(1) : prefix;

    if (isSearch) {
        const metas = META_FILTER_OPS
            .filter(op => !matchQ || op.startsWith(matchQ) || op.includes(matchQ))
            .map(op => ({ name: op, count: 'meta', meta: true }));
        list.unshift(...metas);
    } else if (excludePrefix && matchQ) {
        for (const tag of list) {
            if (!tag.name.startsWith('-')) tag.name = `-${tag.name}`;
        }
    }

    if (!list.length) { suggestions.classList.remove('show'); return; }
    const rect = inputElement.getBoundingClientRect();
    suggestions.style.left = `${rect.left}px`;
    suggestions.style.top = `${rect.bottom + 5}px`;
    suggestions.style.width = `${Math.max(rect.width, 220)}px`;
    suggestions.classList.add('show');
    list.forEach((tag, index) => {
        const item = document.createElement('button');
        item.className = tag.meta ? 'suggestion-item suggestion-meta' : 'suggestion-item';
        item.dataset.index = index;
        const countLabel = tag.meta ? 'meta' : String(tag.count ?? '');
        item.innerHTML = `
            <span>${escapeHtml(tag.name)}</span>
            <span class="suggestion-count">${escapeHtml(countLabel)}</span>
        `;
        item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            applySuggestion(inputElement, tag.name);
        });
        suggestions.appendChild(item);
    });
}

export function getLastWord(str) {
    const parts = str.trim().split(/\s+/);
    return parts.length ? parts[parts.length-1] : '';
}

export async function applySuggestion(inputElement, tagName) {
    const media = await getMediaUi();
    if (inputElement.id === 'editTagsInputModal') {
        const currentTags = state.editingTags || [];
        if (!currentTags.includes(tagName)) {
            currentTags.push(tagName);
            state.editingTags = currentTags;
            media.renderEditTagsList();
        }
        inputElement.value = '';
        suggestions.classList.remove('show');
        selectedSuggestionIndex = -1;
        return;
    }
    if (inputElement.id === 'uploadTagsAddInput') {
        media.addUploadTag(tagName);
        suggestions.classList.remove('show');
        selectedSuggestionIndex = -1;
        return;
    }
    state.tags = mergeFilterToken(parseTagsToArray(state.tags), tagName).join(' ');
    inputElement.value = '';
    suggestions.classList.remove('show');
    selectedSuggestionIndex = -1;
    state.page = 0;
    media.updateActiveTagsDisplay();
    media.loadMedia(0);
}

export function handleSuggestionKeyboard(e, inputElement) {
    const items = suggestions.querySelectorAll('.suggestion-item');
    const open = suggestions.classList.contains('show');

    if (e.key === 'Escape') {
        if (open) {
            e.preventDefault();
            hideSuggestions();
            return true;
        }
        return false;
    }

    if (!items.length || !open) return false;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedSuggestionIndex = Math.min(selectedSuggestionIndex + 1, items.length - 1);
        updateSelectedSuggestion(items);
        return true;
    }
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedSuggestionIndex = Math.max(selectedSuggestionIndex - 1, 0);
        updateSelectedSuggestion(items);
        return true;
    }
    if (e.key === 'Enter' && selectedSuggestionIndex >= 0) {
        e.preventDefault();
        const selectedItem = items[selectedSuggestionIndex];
        if (selectedItem) {
            const tagName = selectedItem.querySelector('span:first-child').textContent;
            applySuggestion(inputElement, tagName);
        }
        return true;
    }
    return false;
}

export function updateSelectedSuggestion(items) {
    items.forEach((item, idx) => {
        if (idx === selectedSuggestionIndex) {
            item.classList.add('selected');
            item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } else {
            item.classList.remove('selected');
        }
    });
}

export const debounce = (fn, delay = 250) => {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn(...args), delay);
    };
};

let suggestionsController = null;

export const handleSuggestionsDebounced = debounce(async (query) => {
    const q = String(query || '').trim();
    if (!q) { suggestions.classList.remove('show'); return; }
    if (suggestionsController) {
        suggestionsController.abort();
        suggestionsController = null;
    }
    const controller = new AbortController();
    suggestionsController = controller;
    try {
        const apiQ = q.startsWith('-') ? q.slice(1) : q;
        let tags = [];
        if (apiQ) {
            const response = await fetch(`/api/tags/autocomplete?query=${encodeURIComponent(apiQ)}`, { signal: controller.signal });
            const data = await response.json();
            tags = data.tags || [];
            if (q.startsWith('-')) {
                tags = tags.map(t => ({ ...t, name: t.name.startsWith('-') ? t.name : `-${t.name}` }));
            }
        }
        if (!controller.signal.aborted) {
            renderSuggestions(tagInput, tags, { query: q });
        }
    } catch (err) {
        if (err.name !== 'AbortError') console.error('Autocomplete error:', err);
    }
}, 250);

export const handleSuggestionsModalDebounced = debounce(async (query) => {
    if (!query.trim()) { suggestions.classList.remove('show'); return; }
    if (suggestionsController) {
        suggestionsController.abort();
        suggestionsController = null;
    }
    const controller = new AbortController();
    suggestionsController = controller;
    try {
        const response = await fetch(`/api/tags/autocomplete?query=${encodeURIComponent(query)}`, { signal: controller.signal });
        const data = await response.json();
        if (!controller.signal.aborted) {
            renderSuggestions(editTagsInputModal, data.tags || []);
        }
    } catch (err) {
        if (err.name !== 'AbortError') console.error('Autocomplete error:', err);
    }
}, 250);

export const handleSuggestionsUploadDebounced = debounce(async (query) => {
    if (!query.trim()) { suggestions.classList.remove('show'); return; }
    if (suggestionsController) {
        suggestionsController.abort();
        suggestionsController = null;
    }
    const controller = new AbortController();
    suggestionsController = controller;
    try {
        const response = await fetch(`/api/tags/autocomplete?query=${encodeURIComponent(query)}`, { signal: controller.signal });
        const data = await response.json();
        if (!controller.signal.aborted) {
            renderSuggestions(uploadTagsAddInput, data.tags || []);
        }
    } catch (err) {
        if (err.name !== 'AbortError') console.error('Autocomplete error:', err);
    }
}, 250);
