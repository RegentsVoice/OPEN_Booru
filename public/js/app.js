import { showToast } from './toast.js';
import { getLanguage, t } from './user-locales.js';
import { state } from './state.js';
import { applyLanguage, updateAllTexts, closeModal } from './utils.js';
import {
    loadMedia, openViewer, closeViewerFn, navigateViewer,
    openUploadModal, closeUploadModalFn, setUploadMode, fetchImportFromUrl, handleFileSelect,
    submitUploadWithStages, openEditTagsModal, closeEditTagsModalFn,
    saveEditedTags, openEditInfoModal, closeEditInfoModalFn, saveEditedInfo,
    addTagFromInput, clearAllTags, addUploadTag, generateShortName,
    getUploadNamePrefix, getNamePrefixFromMediaType, renderEditTagsList,
    updateActiveTagsDisplay, updatePagination, updateViewerContent,
    currentEditInfoPostId
} from './media-ui.js';
import {
    showAuthModal, hideAuthModal, switchAuthTab, checkAuth,
    openUserModal, closeUserModalFn, loadLogs, applyGalleryGridStyles,
    applyDisplaySettings, changeUsername, changePassword,
    loadAccessSettings, saveAccessSettings, saveLanguage, loadUsersList,
    loadBooruCredentialsList, bindBooruSettingsEvents,
    loadTagsList, bindTagsManageEvents,
    handleSuggestionsDebounced, handleSuggestionsModalDebounced,
    handleSuggestionsUploadDebounced, handleSuggestionKeyboard,
    getLastWord, applySuggestion, fetchRegistrationPolicy, applyRegistrationPolicy,
    suggestions, selectedSuggestionIndex, hideSuggestions
} from './auth-settings.js';
import { icons } from './state.js';
import { formatDuration } from './utils.js';
import { bindDuplicatesUi } from './duplicates-ui.js';
const formatTime = (s) => formatDuration(s);

window.__refreshAfterLanguage = () => {
    updateActiveTagsDisplay();
    updatePagination();

    const viewer = document.getElementById('viewer');
    if (viewer && !viewer.classList.contains('hidden') && state.currentMediaId) {
        updateViewerContent();
    }
};

function bindEvents() {
    const tagInput = document.getElementById('tagInput');
    const viewBtn = document.getElementById('viewBtn');
    const clearAllTagsBtn = document.getElementById('clearAllTagsBtn');
    const nextPageBtn = document.getElementById('nextPageBtn');
    const prevPageBtn = document.getElementById('prevPageBtn');
    const favoritesTabsDiv = document.getElementById('favoritesTabs');
    const favTabBtns = document.querySelectorAll('.fav-tab-btn');
    const closeViewer = document.getElementById('closeViewer');
    const uploadBtn = document.getElementById('uploadBtn');
    const closeUploadModal = document.getElementById('closeUploadModal');
    const uploadModal = document.getElementById('uploadModal');
    const dropArea = document.getElementById('dropArea');
    const fileInput = document.getElementById('fileInput');
    const uploadSubmitBtn = document.getElementById('uploadSubmitBtn');
    const generateNameBtn = document.getElementById('generateNameBtn');
    const generateEditNameBtn = document.getElementById('generateEditNameBtn');
    const uploadDisplayName = document.getElementById('uploadDisplayName');
    const editInfoDisplayName = document.getElementById('editInfoDisplayName');
    const uploadTagsAddBtn = document.getElementById('uploadTagsAddBtn');
    const uploadTagsAddInput = document.getElementById('uploadTagsAddInput');
    const closeEditTagsModal = document.getElementById('closeEditTagsModal');
    const editTagsModal = document.getElementById('editTagsModal');
    const editTagsInputModal = document.getElementById('editTagsInputModal');
    const addTagModalBtn = document.getElementById('addTagModalBtn');
    const saveTagsModalBtn = document.getElementById('saveTagsModalBtn');
    const cancelTagsModalBtn = document.getElementById('cancelTagsModalBtn');
    const closeEditInfoModal = document.getElementById('closeEditInfoModal');
    const editInfoModal = document.getElementById('editInfoModal');
    const saveInfoBtn = document.getElementById('saveInfoBtn');
    const cancelInfoBtn = document.getElementById('cancelInfoBtn');
    const userBtn = document.getElementById('userBtn');
    const closeUserModal = document.getElementById('closeUserModal');
    const userModal = document.getElementById('userModal');
    const refreshLogsBtn = document.getElementById('refreshLogsBtn');
    const saveDisplaySettingsBtn = document.getElementById('saveDisplaySettingsBtn');
    const changeUsernameBtn = document.getElementById('changeUsernameBtn');
    const changePasswordBtn = document.getElementById('changePasswordBtn');
    const saveLanguageBtn = document.getElementById('saveLanguageBtn');
    const saveAccessSettingsBtn = document.getElementById('saveAccessSettingsBtn');
    const viewerNavPrev = document.getElementById('viewerNavPrev');
    const viewerNavNext = document.getElementById('viewerNavNext');
    const logoutBtn = document.getElementById('logoutBtn');
    const gallery = document.getElementById('gallery');
    const viewer = document.getElementById('viewer');
    const modalElement = document.getElementById('customModal');

    function normalizeSpacesToUnderscore(e) {
        const input = e.target;
        const start = input.selectionStart;
        const val = input.value;
        const newVal = val.replace(/ /g, '_');
        if (newVal !== val) {
            input.value = newVal;
            input.setSelectionRange(start, start);
        }
    }
    [uploadTagsAddInput, editTagsInputModal].forEach(field => {
        if (field) field.addEventListener('input', normalizeSpacesToUnderscore);
    });

    if (tagInput) {
        tagInput.addEventListener('keydown', (e) => {
            if (handleSuggestionKeyboard(e, tagInput)) return;
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                addTagFromInput();
                hideSuggestions();
            }
        });
        tagInput.addEventListener('input', (e) => {
            const lastWord = getLastWord(e.target.value);
            if (!lastWord.trim()) {
                suggestions.classList.remove('show');
                selectedSuggestionIndex = -1;
                return;
            }
            handleSuggestionsDebounced(lastWord);
        });
    }

    document.addEventListener('click', (e) => {
        if (!suggestions.contains(e.target) &&
            e.target !== tagInput &&
            e.target !== editTagsInputModal &&
            e.target !== uploadTagsAddInput) {
            hideSuggestions();
        }
    });

    const suggestionInputs = [tagInput, editTagsInputModal, uploadTagsAddInput].filter(Boolean);
    suggestionInputs.forEach(input => {
        input.addEventListener('blur', () => {
            setTimeout(() => {
                const active = document.activeElement;
                if (suggestions.contains(active)) return;
                if (suggestionInputs.includes(active)) return;
                hideSuggestions();
            }, 150);
        });
    });

    clearAllTagsBtn?.addEventListener('click', clearAllTags);
    nextPageBtn.addEventListener('click', () => { if (state.page < state.totalPages - 1) loadMedia(state.page + 1); });
    prevPageBtn.addEventListener('click', () => { if (state.page > 0) loadMedia(state.page - 1); });

    viewBtn.addEventListener('click', () => {
        state.viewingFavorites = !state.viewingFavorites;
        if (state.viewingFavorites) {
            viewBtn.classList.add('fav-active');
            favoritesTabsDiv.classList.remove('hidden');
        } else {
            viewBtn.classList.remove('fav-active');
            favoritesTabsDiv.classList.add('hidden');
            state.favoritesTab = 'all';
            favTabBtns.forEach(btn => btn.classList.remove('active'));
            document.querySelector('.fav-tab-btn[data-tab="all"]').classList.add('active');
        }
        state.page = 0;
        loadMedia(0);
    });

    favTabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            favTabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.favoritesTab = btn.dataset.tab;
            state.page = 0;
            loadMedia(0);
        });
    });

    closeViewer.addEventListener('click', closeViewerFn);

    uploadBtn.addEventListener('click', openUploadModal);
    document.querySelectorAll('.upload-mode-tab').forEach(btn => {
        btn.addEventListener('click', () => setUploadMode(btn.dataset.mode));
    });
    const importFetchBtn = document.getElementById('importFetchBtn');
    if (importFetchBtn) importFetchBtn.addEventListener('click', fetchImportFromUrl);
    const importUrlInput = document.getElementById('importUrlInput');
    if (importUrlInput) {
        importUrlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                fetchImportFromUrl();
            }
        });
    }

    closeUploadModal.addEventListener('click', closeUploadModalFn);
    uploadModal.querySelector('.modal-overlay').addEventListener('click', closeUploadModalFn);

    function urlFromDataTransfer(dt) {
        if (!dt) return null;
        const uriList = dt.getData('text/uri-list') || '';
        for (const line of uriList.split(/\r?\n/)) {
            const s = line.trim();
            if (s && !s.startsWith('#') && /^https?:\/\//i.test(s)) return s;
        }
        const plain = (dt.getData('text/plain') || dt.getData('text') || '').trim();
        if (/^https?:\/\/\S+/i.test(plain)) {
            return plain.split(/\s+/)[0];
        }

        const html = dt.getData('text/html') || '';
        const m = html.match(/href=["'](https?:\/\/[^"']+)["']/i);
        if (m) return m[1];
        return null;
    }

    function applyDroppedImportUrl(url) {
        if (!url) return false;
        setUploadMode('import');
        const input = document.getElementById('importUrlInput');
        if (input) {
            input.value = url;
            input.focus();
            input.select?.();
        }

        try { fetchImportFromUrl(); } catch (e) { console.warn(e); }
        return true;
    }

    dropArea.addEventListener('click', (e) => {
        if (dropArea.classList.contains('has-preview')) {
            e.preventDefault();
            return;
        }
        fileInput.click();
    });
    dropArea.addEventListener('dragover', (e) => { e.preventDefault(); dropArea.classList.add('dragover'); });
    dropArea.addEventListener('dragleave', () => dropArea.classList.remove('dragover'));
    dropArea.addEventListener('drop', (e) => {
        e.preventDefault();
        dropArea.classList.remove('dragover');

        if (e.dataTransfer.files && e.dataTransfer.files.length) {
            fileInput.files = e.dataTransfer.files;
            handleFileSelect();
            return;
        }
        const droppedUrl = urlFromDataTransfer(e.dataTransfer);
        if (droppedUrl) { e.stopPropagation(); applyDroppedImportUrl(droppedUrl); }
    });

    const uploadModalEl = document.getElementById('uploadModal');
    const uploadModalContent = uploadModalEl?.querySelector('.modal-content') || uploadModalEl;
    if (uploadModalContent) {
        uploadModalContent.addEventListener('dragover', (e) => {

            const hasFiles = e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
            const hasUri = e.dataTransfer && (
                [...(e.dataTransfer.types || [])].includes('text/uri-list') ||
                [...(e.dataTransfer.types || [])].includes('text/plain')
            );
            if (hasUri || !hasFiles) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                uploadModalContent.classList.add('url-dragover');
            }
        });
        uploadModalContent.addEventListener('dragleave', (e) => {
            if (!uploadModalContent.contains(e.relatedTarget)) {
                uploadModalContent.classList.remove('url-dragover');
            }
        });
        uploadModalContent.addEventListener('drop', (e) => {
            uploadModalContent.classList.remove('url-dragover');

            if (e.dataTransfer?.files?.length) {

                if (!dropArea.contains(e.target) && e.target !== dropArea) {
                    e.preventDefault();
                    e.stopPropagation();
                    setUploadMode('upload');
                    fileInput.files = e.dataTransfer.files;
                    handleFileSelect();
                }
                return;
            }
            const droppedUrl = urlFromDataTransfer(e.dataTransfer);
            if (droppedUrl) {
                e.preventDefault();
                e.stopPropagation();
                applyDroppedImportUrl(droppedUrl);
            }
        });
    }

    fileInput.addEventListener('change', handleFileSelect);
    uploadSubmitBtn.onclick = submitUploadWithStages;

    if (generateNameBtn) {
        generateNameBtn.addEventListener('click', () => {
            if (uploadDisplayName) {
                uploadDisplayName.value = generateShortName(getUploadNamePrefix());
                uploadDisplayName.focus();
            }
        });
    }
    if (generateEditNameBtn) {
        generateEditNameBtn.addEventListener('click', () => {
            if (!editInfoDisplayName) return;
            const post = state.posts.find(p => p.id === currentEditInfoPostId);
            const prefix = getNamePrefixFromMediaType(post?.media_type);
            editInfoDisplayName.value = generateShortName(prefix);
            editInfoDisplayName.focus();
        });
    }

    uploadTagsAddBtn.addEventListener('click', () => {
        const tag = uploadTagsAddInput.value.trim();
        if (tag) {
            addUploadTag(tag);
        }
    });

    uploadTagsAddInput.addEventListener('keydown', (e) => {
        if (handleSuggestionKeyboard(e, uploadTagsAddInput)) return;
        if (e.key === 'Enter') {
            e.preventDefault();
            const tag = uploadTagsAddInput.value.trim();
            if (tag) addUploadTag(tag);
            hideSuggestions();
        }
    });
    uploadTagsAddInput.addEventListener('input', (e) => {
        const lastWord = getLastWord(e.target.value);
        if (!lastWord.trim()) { suggestions.classList.remove('show'); selectedSuggestionIndex = -1; return; }
        handleSuggestionsUploadDebounced(lastWord);
    });

    closeEditTagsModal.addEventListener('click', closeEditTagsModalFn);
    editTagsModal.querySelector('.modal-overlay').addEventListener('click', closeEditTagsModalFn);

    editTagsInputModal.addEventListener('keydown', (e) => {
        if (handleSuggestionKeyboard(e, editTagsInputModal)) return;
        if (e.key === 'Enter') {
            e.preventDefault();
            const tag = editTagsInputModal.value.trim();
            if (tag) {
                const current = state.editingTags || [];
                if (!current.includes(tag)) {
                    current.push(tag);
                    state.editingTags = current;
                    renderEditTagsList();
                }
                editTagsInputModal.value = '';
            }
            hideSuggestions();
        }
    });
    editTagsInputModal.addEventListener('input', (e) => {
        const lastWord = getLastWord(e.target.value);
        if (!lastWord.trim()) { suggestions.classList.remove('show'); selectedSuggestionIndex = -1; return; }
        handleSuggestionsModalDebounced(lastWord);
    });

    addTagModalBtn.addEventListener('click', () => {
        const tag = editTagsInputModal.value.trim();
        if (tag) {
            const current = state.editingTags || [];
            if (!current.includes(tag)) {
                current.push(tag);
                state.editingTags = current;
                renderEditTagsList();
            }
            editTagsInputModal.value = '';
        }
        hideSuggestions();
    });

    saveTagsModalBtn.addEventListener('click', saveEditedTags);
    cancelTagsModalBtn.addEventListener('click', closeEditTagsModalFn);

    closeEditInfoModal.addEventListener('click', closeEditInfoModalFn);
    editInfoModal.querySelector('.modal-overlay').addEventListener('click', closeEditInfoModalFn);
    saveInfoBtn.addEventListener('click', saveEditedInfo);
    cancelInfoBtn.addEventListener('click', closeEditInfoModalFn);

    userBtn.addEventListener('click', openUserModal);
    closeUserModal.addEventListener('click', closeUserModalFn);
    userModal.querySelector('.modal-overlay').addEventListener('click', closeUserModalFn);

    document.querySelectorAll('.settings-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            if (tab.classList.contains('admin-only') && !state.isAdmin) return;
            document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
            const panel = document.getElementById(`panel-${tab.dataset.tab}`);
            if (panel) panel.classList.add('active');
            if (tab.dataset.tab === 'users' && state.isAdmin) loadUsersList();
            if (tab.dataset.tab === 'logs' && state.isAdmin) loadLogs();
            if (tab.dataset.tab === 'booru') loadBooruCredentialsList();
            if (tab.dataset.tab === 'tags') loadTagsList();
            applyLanguage();
        });
    });
    const refreshUsersBtn = document.getElementById('refreshUsersBtn');
    if (refreshUsersBtn) refreshUsersBtn.addEventListener('click', loadUsersList);
    bindBooruSettingsEvents();
    bindTagsManageEvents();
    bindDuplicatesUi();

    refreshLogsBtn?.addEventListener('click', loadLogs);
    saveDisplaySettingsBtn.addEventListener('click', applyDisplaySettings);
    changeUsernameBtn.addEventListener('click', changeUsername);
    changePasswordBtn.addEventListener('click', changePassword);

    const userExportBtn = document.getElementById('userExportBtn');
    const userImportBtn = document.getElementById('userImportBtn');
    const userImportFile = document.getElementById('userImportFile');
    const userDataStatus = document.getElementById('userDataStatus');
    if (userExportBtn) {
        userExportBtn.addEventListener('click', async () => {
            if (userDataStatus) userDataStatus.textContent = t('userExportStarting') || 'Exporting…';
            try {
                const res = await fetch('/api/user/export');
                if (!res.ok) {
                    let msg = 'Export failed';
                    try { const j = await res.json(); msg = j.error || msg; } catch (_) {}
                    throw new Error(msg);
                }
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = 'open-booru-export.tar';
                document.body.appendChild(link);
                link.click();
                link.remove();
                URL.revokeObjectURL(url);
                if (userDataStatus) userDataStatus.textContent = t('userExportDone') || 'Export done';
                showToast(t('userExportDone') || 'Export done', 'success');
            } catch (err) {
                if (userDataStatus) userDataStatus.textContent = err.message;
                showToast(err.message, 'error');
            }
        });
    }
    if (userImportBtn && userImportFile) {
        userImportBtn.addEventListener('click', () => userImportFile.click());
        userImportFile.addEventListener('change', async () => {
            const file = userImportFile.files && userImportFile.files[0];
            userImportFile.value = '';
            if (!file) return;
            const password = (document.getElementById('userImportPassword') || {}).value || '';
            if (!password) {
                showToast(t('userImportPasswordRequired') || 'Enter password for import', 'error');
                return;
            }
            if (!confirm(t('userImportConfirm') || 'Replace all your data with the archive?')) return;
            if (userDataStatus) userDataStatus.textContent = t('userImportStarting') || 'Importing…';
            try {
                const fd = new FormData();
                fd.append('file', file);
                fd.append('password', password);
                const res = await fetch('/api/user/import', { method: 'POST', body: fd });
                const data = await res.json();
                if (!data.success) throw new Error(data.error || 'Import failed');
                if (userDataStatus) userDataStatus.textContent = t('userImportDone') || 'Import done';
                showToast(t('userImportDone') || 'Import done — reloading', 'success');
                setTimeout(() => location.reload(), 800);
            } catch (err) {
                if (userDataStatus) userDataStatus.textContent = err.message;
                showToast(err.message, 'error');
            }
        });
    }

    saveLanguageBtn.addEventListener('click', saveLanguage);
    if (saveAccessSettingsBtn) saveAccessSettingsBtn.addEventListener('click', saveAccessSettings);

    import('./media-ui.js').then((m) => {
        if (m.bindViewerNavigation) m.bindViewerNavigation();
    }).catch(() => {});

    document.addEventListener('keydown', (e) => {
        const viewerEl = document.getElementById('viewer');
        const viewerOpen = viewerEl && !viewerEl.classList.contains('hidden');

        if (e.key === 'Escape') {
            if (viewerOpen) return;
            if (!uploadModal.classList.contains('hidden')) closeUploadModalFn();
            if (!editTagsModal.classList.contains('hidden')) closeEditTagsModalFn();
            if (!editInfoModal.classList.contains('hidden')) closeEditInfoModalFn();
            if (!modalElement.classList.contains('hidden')) closeModal();
            if (!userModal.classList.contains('hidden')) closeUserModalFn();
        }
    }, true);
}

(async function init() {
    let authOk = false;
    try {
        authOk = await checkAuth();
    } catch (err) {
        console.error('checkAuth failed', err);
        try { await showAuthModal(); } catch (e2) { console.error(e2); }
    }
    applyLanguage();

    const limit = parseInt(localStorage.getItem('gallery_limit')) || 27;
    const cardW = parseInt(localStorage.getItem('gallery_cardWidth')) || 220;
    const rowH = parseInt(localStorage.getItem('gallery_rowHeight')) || 250;

    state.limit = limit;
    state.cardWidth = cardW;
    state.rowHeight = rowH;

    applyGalleryGridStyles();
    window.addEventListener('resize', () => {
        clearTimeout(window._galleryGridResizeTimer);
        window._galleryGridResizeTimer = setTimeout(applyGalleryGridStyles, 150);
    });

    if (authOk) {
        await loadMedia(0);
        document.getElementById('favoritesTabs').classList.add('hidden');
    } else {
        document.getElementById('gallery').innerHTML = `<div class="empty-state">${t('pleaseLogin')}</div>`;
    }
    bindEvents();
    applyLanguage();
})();
