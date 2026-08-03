import { showToast } from './toast.js';
import { getLanguage, setLanguage, t } from './user-locales.js';
import { state } from './state.js';
import {
    applyLanguage, updateAllTexts, showAlert, showConfirm, escapeHtml, formatDate
} from './utils.js';
import { loadMedia } from './media-ui.js';

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

export async function showAuthModal() {
    authModal.classList.remove('hidden');
    authError.classList.add('hidden');
    switchAuthTab('login');
    document.getElementById('authUsernameLogin').value = '';
    document.getElementById('authPasswordLogin').value = '';
    document.getElementById('authUsernameRegister').value = '';
    document.getElementById('authPasswordRegister').value = '';
    document.getElementById('authConfirmRegister').value = '';
    applyLanguage();
    const disabled = await fetchRegistrationPolicy();
    await applyRegistrationPolicy(disabled);
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

document.getElementById('authLoginBtn').addEventListener('click', async () => {
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
            loadMedia(0);
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

document.getElementById('authRegisterBtn').addEventListener('click', async () => {
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
            loadMedia(0);
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

logoutBtn.addEventListener('click', async () => {
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

    const activeTab = document.querySelector('.settings-tab.active');
    if (activeTab && activeTab.classList.contains('admin-only') && !state.isAdmin) {
        document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
        const displayTab = document.querySelector('.settings-tab[data-tab="display"]');
        if (displayTab) displayTab.classList.add('active');
        const displayPanel = document.getElementById('panel-display');
        if (displayPanel) displayPanel.classList.add('active');
    }

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
    loadMedia(state.page);
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
            container.innerHTML = `<p class="setting-hint">${t('error')}</p>`;
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
            
            if (!isSelf && !u.is_owner) {
                actions.push(`<button type="button" class="viewer-btn danger-btn user-delete-btn" data-user-id="${u.id}" data-username="${escapeHtml(u.username)}">${t('delete')}</button>`);
            }
            if (state.isOwner && !isSelf && !u.is_owner) {
                if (u.is_admin) {
                    actions.push(`<button type="button" class="viewer-btn user-demote-btn" data-user-id="${u.id}" data-username="${escapeHtml(u.username)}">${t('removeAdmin')}</button>`);
                } else {
                    actions.push(`<button type="button" class="viewer-btn user-promote-btn" data-user-id="${u.id}" data-username="${escapeHtml(u.username)}">${t('makeAdmin')}</button>`);
                }
                actions.push(`<button type="button" class="viewer-btn user-transfer-btn" data-user-id="${u.id}" data-username="${escapeHtml(u.username)}">${t('transferOwnership')}</button>`);
            }

            return `<div class="user-row">
                <div class="user-row-info">
                    <strong>${escapeHtml(u.username)}</strong>
                    <span class="user-row-meta">${dateStr}</span>
                </div>
                <div class="user-row-right">
                    <div class="user-row-badges">${badges.join('')}</div>
                    <div class="user-row-actions">${actions.join('')}</div>
                </div>
            </div>`;
        }).join('');

        container.querySelectorAll('.user-delete-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = parseInt(btn.dataset.userId, 10);
                const name = btn.dataset.username || '';
                const ok = await showConfirm(t('confirmDeleteUser', { name }), t('confirmDeletion'));
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
                const ok = await showConfirm(t('confirmMakeAdmin', { name }), t('makeAdmin'));
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
                const ok = await showConfirm(t('confirmRemoveAdmin', { name }), t('removeAdmin'));
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
                const ok = await showConfirm(t('confirmTransferOwnership', { name }), t('transferOwnership'));
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

suggestions.className = 'suggestions-container';
document.body.appendChild(suggestions);

export function renderSuggestions(inputElement, tags) {
    suggestions.innerHTML = '';
    selectedSuggestionIndex = -1;
    if (!tags.length) { suggestions.classList.remove('show'); return; }
    const rect = inputElement.getBoundingClientRect();
    suggestions.style.left = `${rect.left}px`;
    suggestions.style.top = `${rect.bottom + 5}px`;
    suggestions.style.width = `${rect.width}px`;
    suggestions.classList.add('show');
    tags.forEach((tag, index) => {
        const item = document.createElement('button');
        item.className = 'suggestion-item';
        item.dataset.index = index;
        item.innerHTML = `
            <span>${escapeHtml(tag.name)}</span>
            <span class="suggestion-count">${tag.count}</span>
        `;
        item.addEventListener('click', () => {
            applySuggestion(inputElement, tag.name);
        });
        suggestions.appendChild(item);
    });
}

export function getLastWord(str) {
    const parts = str.trim().split(/\s+/);
    return parts.length ? parts[parts.length-1] : '';
}

export function applySuggestion(inputElement, tagName) {
    if (inputElement.id === 'editTagsInputModal') {
        const currentTags = state.editingTags || [];
        if (!currentTags.includes(tagName)) {
            currentTags.push(tagName);
            state.editingTags = currentTags;
            renderEditTagsList();
        }
        inputElement.value = '';
        suggestions.classList.remove('show');
        selectedSuggestionIndex = -1;
        return;
    }

    if (inputElement.id === 'uploadTagsAddInput') {
        addUploadTag(tagName);
        suggestions.classList.remove('show');
        selectedSuggestionIndex = -1;
        return;
    }

    const currentTags = parseTagsToArray(state.tags);
    if (!currentTags.includes(tagName)) currentTags.push(tagName);
    state.tags = currentTags.join(' ');
    inputElement.value = '';
    suggestions.classList.remove('show');
    selectedSuggestionIndex = -1;
    state.page = 0;
    loadMedia(0);
}

export function handleSuggestionKeyboard(e, inputElement) {
    const items = suggestions.querySelectorAll('.suggestion-item');
    if (!items.length) return false;
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
        if (idx === selectedSuggestionIndex) item.classList.add('selected');
        else item.classList.remove('selected');
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
            renderSuggestions(tagInput, data.tags || []);
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
