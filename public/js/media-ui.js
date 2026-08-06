import { showToast } from './toast.js';
import { getLanguage, t } from './user-locales.js';
import { state, icons } from './state.js';
import {
    escapeHtml, formatDate, formatFileSize, formatDuration, parseTagsToArray,
    showLoading, hideLoading, showAlert, showConfirm, applyLanguage, updateAllTexts
} from './utils.js';

const gallery = document.getElementById('gallery');
const tagInput = document.getElementById('tagInput');
const tagsContainer = document.getElementById('tagsContainer');
const clearAllTagsBtn = document.getElementById('clearAllTagsBtn');
const nextPageBtn = document.getElementById('nextPageBtn');
const prevPageBtn = document.getElementById('prevPageBtn');
const paginationPages = document.getElementById('paginationPages');
const viewer = document.getElementById('viewer');
const viewerImage = document.getElementById('viewerImage');
const viewerInfo = document.getElementById('viewerInfo');
const viewerTagsDisplay = document.getElementById('viewerTagsDisplay');
const viewerActions = document.getElementById('viewerActions');
const viewerNavPrev = document.getElementById('viewerNavPrev');
const viewerNavNext = document.getElementById('viewerNavNext');
const uploadModal = document.getElementById('uploadModal');
const fileInput = document.getElementById('fileInput');
const dropArea = document.getElementById('dropArea');
const fileInfo = document.getElementById('fileInfo');
const uploadDisplayName = document.getElementById('uploadDisplayName');
const uploadDescription = document.getElementById('uploadDescription');
const uploadTagsAddInput = document.getElementById('uploadTagsAddInput');
const uploadTagsContainer = document.getElementById('uploadTagsContainer');
const uploadSubmitBtn = document.getElementById('uploadSubmitBtn');
const uploadCompleteStatus = document.getElementById('uploadCompleteStatus');
const stagesContainer = document.getElementById('stagesContainer');
const editTagsModal = document.getElementById('editTagsModal');
const editTagsInputModal = document.getElementById('editTagsInputModal');
const editTagsList = document.getElementById('editTagsList');
const editInfoModal = document.getElementById('editInfoModal');
const editInfoDisplayName = document.getElementById('editInfoDisplayName');
const editInfoDescription = document.getElementById('editInfoDescription');
export let currentEditInfoPostId = null;
let formatTime = (s) => formatDuration(s);

export function updateViewerContent() {
    const viewer = document.getElementById('viewer');
    if (viewer.classList.contains('hidden') || !state.currentMediaId) return;
    const post = state.posts.find(p => p.id === state.currentMediaId);
    if (!post) return;
    const fileSize = post.file_size || 0;
    const sizeStr = formatFileSize(fileSize);
    viewerInfo.innerHTML = `
        <div><strong>${t('name')}:</strong> ${escapeHtml(post.display_name || post.original_name || '')}</div>
        <div><strong>${t('date')}:</strong> ${formatDate(post.created_at)}</div>
        <div><strong>${t('type')}:</strong> ${post.media_type}</div>
        <div><strong>${t('resolution')}:</strong> ${post.width && post.height ? `${post.width}x${post.height}` : '?'}</div>
        ${post.media_type === 'video' && post.duration ? `<div><strong>${t('duration')}:</strong> ${formatDuration(post.duration)}</div>` : ''}
        <div><strong>${t('size')}:</strong> ${sizeStr}</div>
        <div><strong>${t('description')}:</strong> ${escapeHtml(post.description || '')}</div>
    `;
    renderViewerTags(post.tags || []);
    renderViewerActions(post);
    updateViewerNavButtons();
}

export async function loadMedia(page = 0) {
    if (state.loading) {
        await new Promise(resolve => {
            const check = () => { if (!state.loading) resolve(); else setTimeout(check, 30); };
            check();
        });
    }
    if (state.galleryAbortController) {
        state.galleryAbortController.abort();
        state.galleryAbortController = null;
    }
    const controller = new AbortController();
    state.galleryAbortController = controller;

    state.loading = true;
    showLoading();
    try {
        let url = `/api/media?page=${page}&limit=${state.limit}&tags=${encodeURIComponent(state.tags)}`;
        if (state.viewingFavorites) url += '&favorite=true';
        if (state.favoritesTab !== 'all') {
            let type = state.favoritesTab;
            if (type === 'images') type = 'image';
            else if (type === 'videos') type = 'video';
            else if (type === 'gifs') type = 'gif';
            url += `&type=${type}`;
        }
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data.success) {
            state.posts = data.posts || [];
            state.totalCount = data.totalCount || 0;
            state.totalPages = data.totalPages || 0;
            state.page = page;
        } else {
            state.posts = [];
            state.totalCount = 0;
            state.totalPages = 0;
        }
        renderGallery();
        updatePagination();
        updateActiveTagsDisplay();
        return true;
    } catch (err) {
        if (err.name === 'AbortError') {
            console.log('Request aborted');
            return false;
        }
        console.error('Load media error:', err);
        state.posts = [];
        state.totalCount = 0;
        state.totalPages = 0;
        gallery.innerHTML = `<div class="empty-state">${t('error')}: ${escapeHtml(err.message)}</div>`;
        updatePagination();
        updateActiveTagsDisplay();
        showToast(t('networkError'), 'error');
        return false;
    } finally {
        state.loading = false;
        hideLoading();
        if (state.galleryAbortController === controller) {
            state.galleryAbortController = null;
        }
    }
}

export function renderGallery() {
    document.querySelectorAll('.gallery-card').forEach(card => {
        if (card._hoverTimer) {
            clearTimeout(card._hoverTimer);
            card._hoverTimer = null;
        }
        if (card._hoverHandlers) {
            card.removeEventListener('mouseenter', card._hoverHandlers.enter);
            card.removeEventListener('mouseleave', card._hoverHandlers.leave);
        }
        const video = card.querySelector('video');
        if (video) {
            video.pause();
            video.src = '';
            video.load();
        }
        const gifImg = card.querySelectorAll('img');
        gifImg.forEach(img => {
            if (img.src && img.src.includes('/media/')) {
                img.src = '';
            }
        });
    });
    gallery.innerHTML = '';

    const items = state.posts;
    if (!items.length) {
        gallery.innerHTML = `<div class="empty-state">${t('nothingFound')}</div>`;
        return;
    }
    items.forEach((post, index) => {
        const card = document.createElement('article');
        card.className = 'gallery-card';
        card.dataset.index = index;
        const mediaDiv = document.createElement('div');
        mediaDiv.className = 'gallery-media';

        const isVideo = post.media_type === 'video';
        const isGif = post.media_type === 'gif';
        const posterUrl = post.poster_url || null;

        let hoverTimer = null;
        let videoInstance = null;

        if (isVideo) {
            if (posterUrl) {
                const img = document.createElement('img');
                img.className = 'gallery-media-element';
                img.loading = 'lazy';
                img.src = posterUrl;
                img.alt = post.display_name || post.original_name || 'Video';

                img.onerror = () => {
                    img.style.display = 'none';
                    if (!videoInstance) {
                        const v = document.createElement('video');
                        v.className = 'gallery-media-element';
                        v.muted = true;
                        v.loop = false;
                        v.preload = 'metadata';
                        v.src = `/media/${post.file_hash}`;
                        v.oncanplay = () => v.classList.add('loaded');
                        v.onerror = () => {
                            v.classList.add('loaded');
                            v.style.background = '#222';
                        };
                        mediaDiv.appendChild(v);
                        videoInstance = v;
                        setupVideoHover(v, card);
                    }
                    videoInstance.style.display = 'block';
                };
                img.onload = () => img.classList.add('loaded');
                mediaDiv.appendChild(img);

                const handleEnter = () => {
                    if (hoverTimer) clearTimeout(hoverTimer);
                    hoverTimer = setTimeout(() => {
                        if (!videoInstance) {
                            const v = document.createElement('video');
                            v.className = 'gallery-media-element';
                            v.muted = true;
                            v.loop = false;
                            v.preload = 'metadata';
                            v.src = `/media/${post.file_hash}`;
                            v.oncanplay = () => v.classList.add('loaded');
                            v.onerror = () => {
                                v.classList.add('loaded');
                                v.style.background = '#222';
                            };
                            mediaDiv.appendChild(v);
                            videoInstance = v;
                            setupVideoHover(v, card);
                        }
                        if (img) img.style.display = 'none';
                        if (videoInstance) {
                            videoInstance.style.display = 'block';
                            videoInstance.play().catch(() => {});
                        }
                    }, 1500);
                };
                const handleLeave = () => {
                    if (hoverTimer) {
                        clearTimeout(hoverTimer);
                        hoverTimer = null;
                    }
                    if (videoInstance) {
                        videoInstance.pause();
                        videoInstance.currentTime = 0;
                        videoInstance.style.display = 'none';
                    }
                    if (img) img.style.display = 'block';
                };
                card._hoverTimer = hoverTimer;
                card._hoverHandlers = { enter: handleEnter, leave: handleLeave };
                card.addEventListener('mouseenter', handleEnter);
                card.addEventListener('mouseleave', handleLeave);
            } else {

                const video = document.createElement('video');
                video.className = 'gallery-media-element';
                video.muted = true;
                video.loop = false;
                video.preload = 'metadata';
                video.src = `/media/${post.file_hash}`;
                video.oncanplay = () => video.classList.add('loaded');
                video.onerror = () => {
                    video.classList.add('loaded');
                    video.style.background = '#222';
                };
                mediaDiv.appendChild(video);
                setupVideoHover(video, card);
            }
        } else if (isGif) {
            const posterImg = document.createElement('img');
            posterImg.className = 'gallery-media-element';
            posterImg.loading = 'lazy';
            posterImg.src = posterUrl || `/media/${post.file_hash}?t=${Date.now()}`;
            posterImg.alt = post.display_name || post.original_name || 'GIF';
            posterImg.style.display = 'block';
            posterImg.onerror = () => {
                posterImg.src = `/media/${post.file_hash}?t=${Date.now()}`;
            };
            posterImg.onload = () => posterImg.classList.add('loaded');
            mediaDiv.appendChild(posterImg);

            const gifImg = document.createElement('img');
            gifImg.className = 'gallery-media-element';
            gifImg.loading = 'lazy';
            gifImg.src = '';
            gifImg.alt = post.display_name || post.original_name || 'GIF';
            gifImg.style.display = 'none';
            gifImg.onload = () => gifImg.classList.add('loaded');
            mediaDiv.appendChild(gifImg);

            const handleGifEnter = () => {
                if (hoverTimer) clearTimeout(hoverTimer);
                hoverTimer = setTimeout(() => {
                    const src = `/media/${post.file_hash}?t=${Date.now()}`;
                    gifImg.src = src;
                    gifImg.style.display = 'block';
                    posterImg.style.display = 'none';
                }, 1500);
            };
            const handleGifLeave = () => {
                if (hoverTimer) {
                    clearTimeout(hoverTimer);
                    hoverTimer = null;
                }
                gifImg.style.display = 'none';
                gifImg.src = '';
                posterImg.style.display = 'block';
            };
            card._hoverTimer = hoverTimer;
            card._hoverHandlers = { enter: handleGifEnter, leave: handleGifLeave };
            card.addEventListener('mouseenter', handleGifEnter);
            card.addEventListener('mouseleave', handleGifLeave);
        } else {
            const img = document.createElement('img');
            img.className = 'gallery-media-element';
            img.loading = 'lazy';
            const cacheBuster = Date.now();
            img.src = `/media/${post.file_hash}?t=${cacheBuster}`;
            img.alt = post.display_name || post.original_name || 'Image';
            img.onerror = () => {
                console.error('Image load error:', img.src);
                img.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23666"%3E%3Cpath d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-1 8h-4v4h-4v-4H6V9h4V5h4v4h4v2z"/%3E%3C/svg%3E';
                img.style.objectFit = 'contain';
                img.classList.add('loaded');
            };
            img.onload = () => img.classList.add('loaded');
            mediaDiv.appendChild(img);
        }

        const info = document.createElement('div');
        info.className = 'gallery-info';
        const leftHtml = `<span>${post.is_favorite ? icons.favorite(true) : icons.favorite(false)}</span>`;
        let rightHtml = '';
        if (post.media_type === 'video' && post.duration) {
            rightHtml += `<span class="duration-badge">${formatDuration(post.duration)}</span>`;
        }
        rightHtml += `<span class="type-icon">${icons.type(post.media_type)}</span>`;
        info.innerHTML = leftHtml + `<span class="right-group">${rightHtml}</span>`;

        card.appendChild(mediaDiv);
        card.appendChild(info);
        card.addEventListener('click', () => {
            state.currentPostIndex = index;
            state.currentMediaId = post.id;
            openViewer(post);
        });
        gallery.appendChild(card);
    });
}

export function setupVideoHover(videoEl, card) {
    let hoverTimer = null;
    const handleEnter = () => {
        if (hoverTimer) clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => {
            videoEl.play().catch(() => {});
        }, 1500);
    };
    const handleLeave = () => {
        if (hoverTimer) {
            clearTimeout(hoverTimer);
            hoverTimer = null;
        }
        videoEl.pause();
        videoEl.currentTime = 0;
    };
    card._hoverTimer = hoverTimer;
    card._hoverHandlers = { enter: handleEnter, leave: handleLeave };
    card.addEventListener('mouseenter', handleEnter);
    card.addEventListener('mouseleave', handleLeave);
}

export function updateActiveTagsDisplay() {
    if (!tagsContainer) return;
    if (!state.tags.trim()) {
        tagsContainer.innerHTML = '';
        clearAllTagsBtn?.classList.add('hidden');
        return;
    }
    const tagsArray = parseTagsToArray(state.tags);
    if (tagsArray.length === 0) {
        tagsContainer.innerHTML = '';
        clearAllTagsBtn?.classList.add('hidden');
        return;
    }
    clearAllTagsBtn?.classList.remove('hidden');
    tagsContainer.innerHTML = tagsArray.map(tag =>
        `<span class="active-tag" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}<span class="tag-remove" data-tag="${escapeHtml(tag)}">${icons.close}</span></span>`
    ).join('');
    document.querySelectorAll('.tag-remove').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); removeTag(btn.dataset.tag); });
    });
}

export function removeTag(tagToRemove) {
    const tagsArray = parseTagsToArray(state.tags);
    const newTags = tagsArray.filter(t => t !== tagToRemove);
    state.tags = newTags.join(' ');
    tagInput.value = '';
    state.page = 0;
    loadMedia(0);
}

export function clearAllTags() {
    state.tags = '';
    tagInput.value = '';
    state.page = 0;
    loadMedia(0);
}

export function addTagFromInput() {
    if (!tagInput) return;
    const inputValue = tagInput.value.trim();

    document.querySelectorAll('.suggestions-container').forEach(el => el.classList.remove('show'));
    if (!inputValue) {
        updateActiveTagsDisplay();
        loadMedia(0);
        return;
    }
    const tagsArray = inputValue.split(/[\s,]+/).map(t => t.trim()).filter(t => t);
    if (!tagsArray.length) {
        tagInput.value = '';
        return;
    }
    const currentTags = parseTagsToArray(state.tags);
    const unique = [...new Set([...currentTags, ...tagsArray])];
    state.tags = unique.join(' ');
    tagInput.value = '';
    state.page = 0;
    updateActiveTagsDisplay();
    loadMedia(0);
}

export function updatePagination() {
    if (state.totalPages === 0) {
        paginationPages.innerHTML = `<span class="page-indicator">${t('page')} 1</span>`;
        prevPageBtn.disabled = true;
        nextPageBtn.disabled = true;
        return;
    }
    const page = state.page;
    const totalPages = state.totalPages;
    if (totalPages > 1) {
        const maxVisible = 7;
        let startPage = Math.max(0, page - Math.floor(maxVisible / 2));
        let endPage = Math.min(totalPages - 1, startPage + maxVisible - 1);
        if (endPage - startPage < maxVisible - 1) startPage = Math.max(0, endPage - maxVisible + 1);
        const pages = [];
        if (startPage > 0) {
            pages.push(`<button class="page-number" data-page="0">1</button>`);
            if (startPage > 1) pages.push(`<span class="page-indicator">...</span>`);
        }
        for (let i = startPage; i <= endPage; i++) {
            pages.push(`<button class="page-number ${i === page ? 'active' : ''}" data-page="${i}">${i + 1}</button>`);
        }
        if (endPage < totalPages - 1) {
            if (endPage < totalPages - 2) pages.push(`<span class="page-indicator">...</span>`);
            pages.push(`<button class="page-number" data-page="${totalPages - 1}">${totalPages}</button>`);
        }
        paginationPages.innerHTML = pages.join('');
        document.querySelectorAll('.page-number').forEach(btn => {
            btn.addEventListener('click', () => {
                const newPage = parseInt(btn.dataset.page);
                if (!isNaN(newPage) && newPage !== page) loadMedia(newPage);
            });
        });
    } else {
        paginationPages.innerHTML = `<span class="page-indicator">${t('page')} ${page + 1}</span>`;
    }
    prevPageBtn.disabled = page <= 0;
    nextPageBtn.disabled = page >= totalPages - 1;
}

export async function navigateViewer(direction) {
    if (state.isNavigating) {
        console.log('Navigation already in progress, ignoring');
        return;
    }
    if (viewer.classList.contains('hidden')) return;

    state.isNavigating = true;

    try {
        const items = state.posts;
        if (!items.length) return;

        let newIndex = state.currentPostIndex + direction;
        if (newIndex < 0) {
            if (state.page > 0) {
                const ok = await loadMedia(state.page - 1);
                if (ok && state.posts.length > 0) {
                    state.currentPostIndex = state.posts.length - 1;
                    state.currentMediaId = state.posts[state.currentPostIndex].id;
                    await openViewer(state.posts[state.currentPostIndex]);
                }
            }
        } else if (newIndex >= items.length) {
            if (state.page < state.totalPages - 1) {
                const ok = await loadMedia(state.page + 1);
                if (ok && state.posts.length > 0) {
                    state.currentPostIndex = 0;
                    state.currentMediaId = state.posts[0].id;
                    await openViewer(state.posts[0]);
                }
            }
        } else {
            state.currentPostIndex = newIndex;
            state.currentMediaId = items[newIndex].id;
            await openViewer(items[newIndex]);
        }
    } catch (err) {
        console.error('Navigation error:', err);
    } finally {
        state.isNavigating = false;
        updateViewerNavButtons();
    }
}

export async function openViewer(post) {
    if (state.currentViewerMedia) {
        if (typeof state.currentViewerMedia.pause === 'function') state.currentViewerMedia.pause();
        if (state.currentViewerMedia.src) {
            state.currentViewerMedia.src = '';

            if (typeof state.currentViewerMedia.load === 'function') {
                state.currentViewerMedia.load();
            }
        }
        state.currentViewerMedia.remove();
        state.currentViewerMedia = null;
    }
    viewerImage.innerHTML = '';
    state.viewerCloseRequested = false;
    state.isNavigating = false;

    viewer.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    const fileSize = post.file_size || 0;
    const sizeStr = formatFileSize(fileSize);
    viewerInfo.innerHTML = `
        <div><strong>${t('name')}:</strong> ${escapeHtml(post.display_name || post.original_name || '')}</div>
        <div><strong>${t('date')}:</strong> ${formatDate(post.created_at)}</div>
        <div><strong>${t('type')}:</strong> ${post.media_type}</div>
        <div><strong>${t('resolution')}:</strong> ${post.width && post.height ? `${post.width}x${post.height}` : '?'}</div>
        ${post.media_type === 'video' && post.duration ? `<div><strong>${t('duration')}:</strong> ${formatDuration(post.duration)}</div>` : ''}
        <div><strong>${t('size')}:</strong> ${sizeStr}</div>
        <div><strong>${t('description')}:</strong> ${escapeHtml(post.description || '')}</div>
    `;

    const tags = post.tags || [];
    renderViewerTags(tags);
    renderViewerActions(post);
    state.currentMediaId = post.id;

    viewerImage.innerHTML = '';
    const container = document.createElement('div');
    container.style.width = container.style.height = '100%';
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.justifyContent = 'center';
    container.style.position = 'relative';

    const isVideo = post.media_type === 'video';
    const fileUrl = `/media/${post.file_hash}`;

    if (isVideo) {
        const video = document.createElement('video');
        video.className = 'viewer-media-element';
        video.controls = false;
        video.autoplay = true;
        video.loop = true;
        video.preload = 'metadata';
        video.src = fileUrl;
        video.style.width = '100%';
        video.style.height = '100%';
        video.style.display = 'block';
        video.style.objectFit = 'contain';

        video.onerror = () => {
            console.error('Video playback error');
        };

        container.appendChild(video);
        state.currentViewerMedia = video;
        createVideoPlayer(video, container, false);
        viewerImage.appendChild(container);
    } else {
        const img = document.createElement('img');
        img.className = 'viewer-media-element';
        const cacheBuster = Date.now();
        img.src = `${fileUrl}?t=${cacheBuster}`;
        img.alt = post.display_name || post.original_name || 'Media';
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'contain';
        img.style.display = 'block';
        img.onerror = () => {
            if (state.viewerCloseRequested) return;
            console.error('Image load error:', img.src);
            img.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23666"%3E%3Cpath d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-1 8h-4v4h-4v-4H6V9h4V5h4v4h4v2z"/%3E%3C/svg%3E';
            img.style.objectFit = 'contain';
        };
        img.onload = () => {
            if (state.viewerCloseRequested) {
                img.remove();
                return;
            }
            img.classList.add('loaded');
            const nw = img.naturalWidth || 0;
            const nh = img.naturalHeight || 0;
            if (nw && nh && (!post.width || !post.height)) {
                post.width = nw;
                post.height = nh;
                const inState = state.posts.find(p => p.id === post.id);
                if (inState) {
                    inState.width = nw;
                    inState.height = nh;
                }
                if (state.currentMediaId === post.id && !viewer.classList.contains('hidden')) {
                    updateViewerContent();
                }
            }
        };
        container.appendChild(img);
        state.currentViewerMedia = img;
        viewerImage.appendChild(container);
    }
    updateViewerNavButtons();
}

export function closeViewerFn() {
    state.viewerCloseRequested = true;
    state.isNavigating = false;
    if (state.currentViewerMedia) {
        if (typeof state.currentViewerMedia.pause === 'function') state.currentViewerMedia.pause();
        if (state.currentViewerMedia.src) {
            state.currentViewerMedia.onerror = null;
            state.currentViewerMedia.onload = null;
            state.currentViewerMedia.src = '';

            if (typeof state.currentViewerMedia.load === 'function') {
                state.currentViewerMedia.load();
            }
        }
        state.currentViewerMedia.remove();
        state.currentViewerMedia = null;
    }
    viewerImage.innerHTML = '';
    viewer.classList.add('hidden');
    document.body.style.overflow = '';
}

export function updateViewerNavButtons() {
    if (!viewerNavPrev || !viewerNavNext) return;
    const items = state.posts;
    if (!items.length) {
        viewerNavPrev.style.display = 'none';
        viewerNavNext.style.display = 'none';
        return;
    }
    const canPrev = state.currentPostIndex > 0 || state.page > 0;
    const canNext = state.currentPostIndex < items.length - 1 || state.page < state.totalPages - 1;
    viewerNavPrev.style.display = canPrev ? 'flex' : 'none';
    viewerNavNext.style.display = canNext ? 'flex' : 'none';
}

export function renderViewerTags(tags) {
    viewerTagsDisplay.innerHTML = '';
    if (!tags || !tags.length) {
        viewerTagsDisplay.innerHTML = `<div class="empty-state">${t('noTags')}</div>`;
        return;
    }
    viewerTagsDisplay.innerHTML = tags.map(tag =>
        `<button class="tag-chip" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`
    ).join('');
    document.querySelectorAll('#viewerTagsDisplay .tag-chip').forEach(chip => {
        chip.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const tag = (chip.dataset.tag || chip.textContent || '').trim();
            if (!tag) return;
            const current = parseTagsToArray(state.tags);
            if (!current.includes(tag)) current.push(tag);
            state.tags = current.join(' ');
            tagInput.value = '';
            state.page = 0;
            updateActiveTagsDisplay();
            closeViewerFn();
            loadMedia(0);
        });
    });
}

export async function renderViewerActions(post) {
    viewerActions.innerHTML = '';
    const favoriteBtn = document.createElement('button');
    favoriteBtn.className = 'viewer-btn';
    const updateFavoriteText = () => {
        favoriteBtn.innerHTML = post.is_favorite
            ? `${icons.favorite(true)} ${t('removeFromFavorites')}`
            : `${icons.favorite(false)} ${t('addToFavorites')}`;
    };
    updateFavoriteText();
    favoriteBtn.addEventListener('click', async () => {
        await toggleFavorite(post.id);
        post.is_favorite = !post.is_favorite;
        updateFavoriteText();
        renderGallery();
    });

    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'viewer-btn';
    downloadBtn.innerHTML = `${icons.download} ${t('download')}`;
    downloadBtn.addEventListener('click', () => {
        downloadFile(post);
    });

    const editInfoBtnAction = document.createElement('button');
    editInfoBtnAction.className = 'viewer-btn';
    editInfoBtnAction.innerHTML = `${icons.edit} ${t('editInfo')}`;
    editInfoBtnAction.addEventListener('click', () => {
        openEditInfoModal(post);
    });

    const editTagsBtnAction = document.createElement('button');
    editTagsBtnAction.className = 'viewer-btn';
    editTagsBtnAction.innerHTML = `${icons.edit} ${t('editTags')}`;
    editTagsBtnAction.addEventListener('click', () => {
        openEditTagsModal(post);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'viewer-btn danger-btn';
    deleteBtn.innerHTML = `${icons.delete} ${t('delete')}`;
    deleteBtn.addEventListener('click', async () => {
        const confirmed = await showConfirm(
            t('confirmDelete').replace('{name}', post.display_name || post.original_name || post.id),
            t('confirmDeletion'),
            { confirmLabel: t('delete'), confirmClass: 'btn-danger' }
        );
        if (confirmed) {
            await deleteMedia(post.id);
            closeViewerFn();
            loadMedia(state.page);
        }
    });

    viewerActions.appendChild(favoriteBtn);
    viewerActions.appendChild(downloadBtn);
    viewerActions.appendChild(editInfoBtnAction);
    viewerActions.appendChild(editTagsBtnAction);
    viewerActions.appendChild(deleteBtn);
}

export async function toggleFavorite(id) {
    try {
        const response = await fetch(`/api/media/${id}/favorite`, { method: 'POST' });
        const data = await response.json();
        if (!data.success) console.error('Failed to toggle favorite');
    } catch (err) { console.error(err); }
}

export async function deleteMedia(id) {
    try {
        const response = await fetch(`/api/media/${id}`, { method: 'DELETE' });
        const data = await response.json();
        if (!data.success) console.error('Failed to delete');
    } catch (err) { console.error(err); }
}

export function downloadFile(post) {
    const url = post.file_url;
    const filename = post.display_name || post.original_name || `file_${post.id}`;
    let ext = '';
    if (post.original_name) {
        const parts = post.original_name.split('.');
        if (parts.length > 1) ext = '.' + parts.pop();
    }
    const fullName = filename + ext;
    const a = document.createElement('a');
    a.href = url;
    a.download = fullName;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

export function createVideoPlayer(video, container, isUploadPreview = false) {
    let savedVolume = 1;
    if (!isUploadPreview) {
        savedVolume = localStorage.getItem('video_volume');
        if (savedVolume === null) savedVolume = 1;
        else savedVolume = parseFloat(savedVolume);
        video.volume = savedVolume;
    } else {
        video.muted = true;
    }

    const controls = document.createElement('div');
    controls.className = `video-controls ${isUploadPreview ? 'video-controls-preview' : 'video-controls-full'}`;

    const progressWrap = document.createElement('div');
    progressWrap.className = 'video-progress-wrap';

    const progressBar = document.createElement('div');
    progressBar.className = 'video-progress-bar';

    const progressFill = document.createElement('div');
    progressFill.className = 'video-progress-fill';
    progressFill.style.width = '0%';

    const thumb = document.createElement('div');
    thumb.className = 'video-progress-thumb';
    thumb.style.left = '0%';

    progressBar.appendChild(progressFill);
    progressBar.appendChild(thumb);

    const track = document.createElement('div');
    track.className = 'video-progress-track';
    progressBar.appendChild(track);
    progressWrap.appendChild(progressBar);

    let isDragging = false;
    let dragRatio = 0;
    let rafId = null;

    function formatTime(seconds) {
        if (!seconds || isNaN(seconds) || seconds < 0) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    function setVisualProgress(ratio) {
        ratio = Math.max(0, Math.min(1, ratio));
        const percent = ratio * 100;
        progressFill.style.width = percent + '%';
        thumb.style.left = percent + '%';
        if (!isUploadPreview && video._timeDisplay && video.duration) {
            const t = isDragging ? ratio * video.duration : video.currentTime;
            video._timeDisplay.textContent = `${formatTime(t)} / ${formatTime(video.duration)}`;
        }
    }

    function ratioFromClientX(clientX) {
        const rect = progressBar.getBoundingClientRect();
        if (rect.width <= 0) return 0;
        return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    }

    function commitSeek(ratio) {
        if (!video.duration || !isFinite(video.duration)) return;
        const target = ratio * video.duration;

        video.currentTime = Math.max(0, Math.min(video.duration - 0.05, target));
        setVisualProgress(ratio);
    }

    const onPointerMove = (e) => {
        if (!isDragging) return;
        e.preventDefault();
        const clientX = e.clientX ?? (e.touches && e.touches[0] ? e.touches[0].clientX : null);
        if (clientX == null) return;
        dragRatio = ratioFromClientX(clientX);
        setVisualProgress(dragRatio);
    };

    const onPointerUp = (e) => {
        if (!isDragging) return;
        isDragging = false;
        thumb.style.cursor = 'grab';
        progressBar.classList.remove('dragging');
        document.removeEventListener('mousemove', onPointerMove);
        document.removeEventListener('mouseup', onPointerUp);
        document.removeEventListener('touchmove', onPointerMove);
        document.removeEventListener('touchend', onPointerUp);
        document.removeEventListener('touchcancel', onPointerUp);
        commitSeek(dragRatio);
    };

    const startDrag = (clientX) => {
        if (!video.duration || !isFinite(video.duration)) return;
        isDragging = true;
        thumb.style.cursor = 'grabbing';
        progressBar.classList.add('dragging');
        dragRatio = ratioFromClientX(clientX);
        setVisualProgress(dragRatio);
        document.addEventListener('mousemove', onPointerMove, { passive: false });
        document.addEventListener('mouseup', onPointerUp);
        document.addEventListener('touchmove', onPointerMove, { passive: false });
        document.addEventListener('touchend', onPointerUp);
        document.addEventListener('touchcancel', onPointerUp);
    };

    track.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startDrag(e.clientX);
    });
    track.addEventListener('touchstart', (e) => {
        if (e.touches[0]) {
            e.preventDefault();
            e.stopPropagation();
            startDrag(e.touches[0].clientX);
        }
    }, { passive: false });

    function tickProgress() {
        if (!isDragging && video.duration && isFinite(video.duration) && video.duration > 0) {
            setVisualProgress(video.currentTime / video.duration);
        }
        if (!video.paused && !video.ended) {
            rafId = requestAnimationFrame(tickProgress);
        } else {
            rafId = null;
        }
    }

    video.addEventListener('play', () => {
        if (rafId == null) rafId = requestAnimationFrame(tickProgress);
    });
    video.addEventListener('pause', () => {
        if (rafId != null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
        if (!isDragging && video.duration) {
            setVisualProgress(video.currentTime / video.duration);
        }
    });
    video.addEventListener('ended', () => {
        if (rafId != null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
        setVisualProgress(1);
    });
    video.addEventListener('seeked', () => {
        if (!isDragging && video.duration) {
            setVisualProgress(video.currentTime / video.duration);
        }
    });

    if (!isUploadPreview) {
        const playBtn = document.createElement('button');
        playBtn.className = 'video-btn video-btn-full';
        playBtn.innerHTML = icons.play;
        playBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (video.paused) {
                video.play();
                playBtn.innerHTML = icons.pause;
            } else {
                video.pause();
                playBtn.innerHTML = icons.play;
            }
        });
        video.addEventListener('play', () => { playBtn.innerHTML = icons.pause; });
        video.addEventListener('pause', () => { playBtn.innerHTML = icons.play; });
        controls.appendChild(playBtn);

        const timeDisplay = document.createElement('span');
        timeDisplay.className = 'video-time-display video-time-full';
        timeDisplay.textContent = '0:00 / 0:00';
        video.addEventListener('loadedmetadata', () => {
            timeDisplay.textContent = `0:00 / ${formatTime(video.duration)}`;
            if (video.duration) setVisualProgress(0);
        });

        video.addEventListener('timeupdate', () => {
            if (isDragging) return;
            if (video.duration) setVisualProgress(video.currentTime / video.duration);
        });
        progressWrap.appendChild(timeDisplay);
        video._timeDisplay = timeDisplay;

        controls.appendChild(progressWrap);

        const volumeWrap = document.createElement('div');
        volumeWrap.className = 'video-volume-wrap';

        const volumeBtn = document.createElement('button');
        volumeBtn.className = 'video-btn video-btn-full';
        volumeBtn.innerHTML = video.volume > 0 ? icons.volume : icons.volumeOff;
        volumeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (video.volume > 0) {
                video.volume = 0;
                volumeBtn.innerHTML = icons.volumeOff;
            } else {
                video.volume = savedVolume || 0.5;
                volumeBtn.innerHTML = icons.volume;
            }
            localStorage.setItem('video_volume', video.volume);
            volumeSlider.value = video.volume;
        });

        const volumeSlider = document.createElement('input');
        volumeSlider.type = 'range';
        volumeSlider.min = 0;
        volumeSlider.max = 1;
        volumeSlider.step = 0.01;
        volumeSlider.value = video.volume;
        volumeSlider.className = 'video-volume-slider video-volume-slider-full';

        volumeSlider.addEventListener('input', () => {
            video.volume = parseFloat(volumeSlider.value);
            volumeBtn.innerHTML = video.volume > 0 ? icons.volume : icons.volumeOff;
            localStorage.setItem('video_volume', video.volume);
        });
        video.addEventListener('volumechange', () => {
            localStorage.setItem('video_volume', video.volume);
            volumeSlider.value = video.volume;
            volumeBtn.innerHTML = video.volume > 0 ? icons.volume : icons.volumeOff;
        });

        volumeWrap.appendChild(volumeBtn);
        volumeWrap.appendChild(volumeSlider);

        const fullscreenBtn = document.createElement('button');
        fullscreenBtn.className = 'video-btn video-btn-full';
        fullscreenBtn.innerHTML = icons.fullscreen;
        fullscreenBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!document.fullscreenElement) {
                container.requestFullscreen().catch(() => {});
            } else {
                document.exitFullscreen();
            }
        });
        document.addEventListener('fullscreenchange', () => {
            fullscreenBtn.innerHTML = document.fullscreenElement ? icons.fullscreenExit : icons.fullscreen;
        });
        volumeWrap.appendChild(fullscreenBtn);
        controls.appendChild(volumeWrap);

        container.addEventListener('wheel', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const step = 0.05;
            let newVol = video.volume + (e.deltaY > 0 ? -step : step);
            newVol = Math.max(0, Math.min(1, newVol));
            video.volume = newVol;
            localStorage.setItem('video_volume', newVol);
            volumeSlider.value = newVol;
            volumeBtn.innerHTML = newVol > 0 ? icons.volume : icons.volumeOff;
        }, { passive: false });

        video.addEventListener('click', (e) => {
            e.stopPropagation();
            if (video.paused) {
                video.play();
            } else {
                video.pause();
            }
        });

        video._volumeSlider = volumeSlider;
        video._volumeBtn = volumeBtn;
        video._playBtn = playBtn;

    } else {

        controls.appendChild(progressWrap);

        video.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }

    container.appendChild(controls);

    function captureVideoFrame(video, time) {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 360;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        state.previewPosterDataURL = canvas.toDataURL('image/jpeg', 0.85);
        state.selectedPosterTime = time;

        const area = document.getElementById('dropArea');
        if (area) {
            const oldThumb = area.querySelector('.captured-thumb');
            if (oldThumb) oldThumb.remove();
            const thumbEl = document.createElement('img');
            thumbEl.className = 'captured-thumb';
            thumbEl.src = state.previewPosterDataURL;
            area.style.position = 'relative';
            area.appendChild(thumbEl);
        }
        updateUploadButtonState();
    }

    video._progressFill = progressFill;
    video._thumb = thumb;
    video._controls = controls;

    let hideTimeout = null;
    const showControls = () => {
        controls.classList.add('show');
        clearTimeout(hideTimeout);
    };
    const hideControlsDelayed = () => {
        clearTimeout(hideTimeout);
        hideTimeout = setTimeout(() => {
            controls.classList.remove('show');
        }, 3000);
    };

    container.addEventListener('mouseenter', showControls);
    container.addEventListener('mouseleave', hideControlsDelayed);
    container.addEventListener('touchstart', () => {
        showControls();
        hideControlsDelayed();
    }, { passive: true });

    if (video.duration && video._timeDisplay) {
        video._timeDisplay.textContent = `0:00 / ${formatTime(video.duration)}`;
    }

    return { captureVideoFrame };
}

export function openEditInfoModal(post) {
    currentEditInfoPostId = post.id;
    editInfoDisplayName.value = post.display_name || '';
    editInfoDescription.value = post.description || '';
    editInfoModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    applyLanguage();
}

export function closeEditInfoModalFn() {
    editInfoModal.classList.add('hidden');
    document.body.style.overflow = '';
    currentEditInfoPostId = null;
}

export async function saveEditedInfo() {
    const id = currentEditInfoPostId;
    if (!id) return;
    const displayName = editInfoDisplayName.value.trim();
    const description = editInfoDescription.value.trim();
    try {
        const response = await fetch(`/api/media/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ displayName, description })
        });
        const data = await response.json();
        if (data.success) {
            const post = state.posts.find(p => p.id === id);
            if (post) {
                post.display_name = displayName;
                post.description = description;
                updateViewerContent();
                renderGallery();
            }
            closeEditInfoModalFn();
            showToast(t('infoSaved'), 'success');
        } else {
            console.error('Failed to save info:', data);
            showToast(t('infoSaveError'), 'error');
        }
    } catch (err) {
        console.error('Save info error:', err);
        showToast(t('networkError'), 'error');
    }
}

export function openEditTagsModal(post) {
    state.editingTags = [...(post.tags || [])];
    renderEditTagsList();
    editTagsInputModal.value = '';
    editTagsModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    editTagsModal.dataset.mediaId = post.id;
    applyLanguage();
}

export function closeEditTagsModalFn() {
    editTagsModal.classList.add('hidden');
    document.body.style.overflow = '';
    suggestions.classList.remove('show');
}

export function renderEditTagsList() {
    editTagsList.innerHTML = '';
    if (!state.editingTags || state.editingTags.length === 0) {
        editTagsList.innerHTML = `<div class="empty-state">${t('noTags')}</div>`;
        return;
    }
    state.editingTags.forEach(tag => {
        const chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.innerHTML = `${escapeHtml(tag)} <span class="tag-remove" data-tag="${escapeHtml(tag)}">${icons.close}</span>`;
        chip.style.cursor = 'pointer';
        const removeBtn = chip.querySelector('.tag-remove');
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tagToRemove = removeBtn.dataset.tag;
            state.editingTags = state.editingTags.filter(t => t !== tagToRemove);
            renderEditTagsList();
        });
        editTagsList.appendChild(chip);
    });
}

export async function saveEditedTags() {
    const mediaId = parseInt(editTagsModal.dataset.mediaId);
    if (!mediaId) return;
    const tags = state.editingTags.join(' ');
    try {
        const response = await fetch(`/api/media/${mediaId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags })
        });
        const data = await response.json();
        if (data.success) {
            const post = state.posts.find(p => p.id === mediaId);
            if (post) {
                post.tags = state.editingTags;
                renderViewerTags(state.editingTags);
                renderGallery();
            }
            closeEditTagsModalFn();
            showToast(t('tagsSaved'), 'success');
        } else {
            console.error('Failed to save tags:', data);
            showToast(t('tagsSaveError'), 'error');
        }
    } catch (err) {
        console.error('Save tags error:', err);
        showToast(t('networkError'), 'error');
    }
}

let statusPollingInterval = null;
let currentProgressElement = null;

export function clearProgress() {
    const container = document.getElementById('stagesContainer');
    if (container) {
        container.innerHTML = '';
    }
    currentProgressElement = null;
    const statusEl = document.getElementById('uploadCompleteStatus');
    if (statusEl) statusEl.style.display = 'none';
}

export function showProgress(_percent) {
    const container = document.getElementById('stagesContainer');
    if (!container) return;
    if (!currentProgressElement) {
        const wrapper = document.createElement('div');
        wrapper.className = 'upload-clock-wrapper';
        wrapper.innerHTML = `
            <svg class="upload-clock" viewBox="0 0 64 64" width="48" height="48" aria-hidden="true">
                <circle class="clock-face" cx="32" cy="32" r="28" fill="none" stroke="currentColor" stroke-width="3"/>
                <circle class="clock-center" cx="32" cy="32" r="3" fill="currentColor"/>
                <line x1="32" y1="8"  x2="32" y2="12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
                <line x1="32" y1="52" x2="32" y2="56" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
                <line x1="8"  y1="32" x2="12" y2="32" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
                <line x1="52" y1="32" x2="56" y2="32" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
                <line x1="15.5" y1="15.5" x2="18.3" y2="18.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                <line x1="45.7" y1="45.7" x2="48.5" y2="48.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                <line x1="15.5" y1="48.5" x2="18.3" y2="45.7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                <line x1="45.7" y1="18.3" x2="48.5" y2="15.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                <line class="clock-hand hour-hand"  x1="32" y1="32" x2="32" y2="18" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
                <line class="clock-hand minute-hand" x1="32" y1="32" x2="32" y2="12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
            </svg>
            <span class="upload-clock-label">${t('uploadProgress') || 'Processing…'}</span>
        `;
        container.appendChild(wrapper);
        currentProgressElement = wrapper;
    }
}

export function updateProgress(percent) {
    showProgress(percent);
}

export function updateUploadButtonState() {
    if (state.uploadMode === 'import') {
        if (!state.importTempId) {
            uploadSubmitBtn.disabled = true;
            return;
        }
        const isVideo = state.importMediaType === 'video';
        const isGif = state.importMediaType === 'gif';
        if ((isVideo || isGif) && !state.previewPosterDataURL) {
            if (isVideo && state.previewVideoEl && !state.previewVideoEl.videoWidth) {
                uploadSubmitBtn.disabled = true;
                uploadSubmitBtn.title = t('posterRequired') || 'Please wait for video';
                return;
            }
            if (isGif) {
                uploadSubmitBtn.disabled = true;
                uploadSubmitBtn.title = t('posterRequired') || 'Please wait for preview';
                return;
            }
        }
        uploadSubmitBtn.disabled = false;
        uploadSubmitBtn.title = '';
        return;
    }

    const file = fileInput.files[0];
    if (!file) {
        uploadSubmitBtn.disabled = true;
        return;
    }
    const isVideo = file.type.startsWith('video/');
    const isGif = file.type === 'image/gif';

    if (isGif && !state.previewPosterDataURL) {
        uploadSubmitBtn.disabled = true;
        uploadSubmitBtn.title = t('posterRequired') || 'Please wait for preview';
        return;
    }
    if (isVideo && state.previewVideoEl && !state.previewVideoEl.videoWidth) {
        uploadSubmitBtn.disabled = true;
        uploadSubmitBtn.title = t('posterRequired') || 'Please wait for video';
        return;
    }
    uploadSubmitBtn.disabled = false;
    uploadSubmitBtn.title = '';
}

export function showFilePreview(file) {
    const area = document.getElementById('dropArea');
    if (!area) return;

    state.previewPosterDataURL = null;
    state.selectedPosterTime = null;
    state.previewVideoEl = null;
    state.videoMetadata = { width: 0, height: 0, duration: 0 };

    area.innerHTML = '';

    const mediaWrapper = document.createElement('div');
    mediaWrapper.style.cssText = 'width:100%; height:100%; display:flex; align-items:center; justify-content:center; position:relative;';

    const isVideo = file.type.startsWith('video/');
    const isGif = file.type === 'image/gif';
    let mediaElement;

    if (isVideo) {
        mediaElement = document.createElement('video');
        mediaElement.src = URL.createObjectURL(file);
        mediaElement.controls = false;
        mediaElement.autoplay = false;
        mediaElement.muted = true;
        mediaElement.playsInline = true;
        mediaElement.loop = false;
        mediaElement.preload = 'auto';
        mediaElement.style.cssText = 'width:100%; height:100%; object-fit:contain; background:#000;';
        mediaWrapper.appendChild(mediaElement);

        state.previewVideoEl = mediaElement;
        state.previewPosterDataURL = null;

        mediaElement.addEventListener('loadedmetadata', () => {
            state.videoMetadata.width = mediaElement.videoWidth || 0;
            state.videoMetadata.height = mediaElement.videoHeight || 0;
            state.videoMetadata.duration = mediaElement.duration || 0;

            try {
                mediaElement.currentTime = (mediaElement.duration > 0.5) ? 0.05 : 0;
            } catch (_) {}
            updateUploadButtonState();
        });

        createVideoPlayer(mediaElement, mediaWrapper, true);
    } else {
        mediaElement = document.createElement('img');
        mediaElement.src = URL.createObjectURL(file);
        mediaElement.alt = file.name;
        mediaElement.style.cssText = 'width:100%; height:100%; object-fit:contain; background:#000;';
        mediaElement.onload = () => {
            const w = mediaElement.naturalWidth || mediaElement.width || 0;
            const h = mediaElement.naturalHeight || mediaElement.height || 0;
            state.videoMetadata.width = w;
            state.videoMetadata.height = h;
            state.videoMetadata.duration = 0;
            if (isGif) {
                const canvas = document.createElement('canvas');
                canvas.width = w || 1;
                canvas.height = h || 1;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(mediaElement, 0, 0, canvas.width, canvas.height);
                state.previewPosterDataURL = canvas.toDataURL('image/jpeg', 0.85);
                state.selectedPosterTime = 0;
            }
            updateUploadButtonState();
        };
        mediaWrapper.appendChild(mediaElement);
    }

    area.appendChild(mediaWrapper);

    if (state.previewFileUrl) URL.revokeObjectURL(state.previewFileUrl);
    state.previewFileUrl = URL.createObjectURL(file);
    state.previewFileType = file.type;
    state.previewFileName = file.name;

    area.classList.add('has-preview');
    const fileInfoDiv = document.getElementById('fileInfo');
    if (fileInfoDiv) fileInfoDiv.classList.remove('hidden');

    updateUploadButtonState();
}

export function capturePreviewFrame(video, time) {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 360;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    state.previewPosterDataURL = canvas.toDataURL('image/jpeg', 0.85);
    state.selectedPosterTime = time;

    const areas = [document.getElementById('dropArea'), document.getElementById('importPreviewArea')].filter(Boolean);
    for (const area of areas) {
        if (!area.classList.contains('has-preview')) continue;
        const oldThumb = area.querySelector('.captured-thumb');
        if (oldThumb) oldThumb.remove();
        const thumbEl = document.createElement('img');
        thumbEl.className = 'captured-thumb';
        thumbEl.src = state.previewPosterDataURL;
        area.style.position = 'relative';
        area.appendChild(thumbEl);
    }
    updateUploadButtonState();
    showToast(t('frameCaptured').replace('{time}', formatTime(time)), 'success');
}

export function getNamePrefixFromMediaType(mediaType) {
    if (mediaType === 'gif') return 'gif-';
    if (mediaType === 'video') return 'vid-';
    if (mediaType === 'image') return 'img-';
    return 'file-';
}

export function getUploadNamePrefix() {
    const file = fileInput?.files?.[0];
    if (file) {
        const mime = (file.type || '').toLowerCase();
        const name = (file.name || '').toLowerCase();
        if (mime === 'image/gif' || name.endsWith('.gif')) return 'gif-';
        if (mime.startsWith('video/') || /\.(mp4|webm|mkv|avi|mov|m4v)$/.test(name)) return 'vid-';
        if (mime.startsWith('image/') || /\.(jpe?g|png|webp|bmp|svg)$/.test(name)) return 'img-';
        return 'file-';
    }
    const t = (state.previewFileType || '').toLowerCase();
    if (t === 'image/gif') return 'gif-';
    if (t.startsWith('video/')) return 'vid-';
    if (t.startsWith('image/')) return 'img-';
    return 'file-';
}

export function generateShortName(prefix) {

    const consonants = 'bcdfghjklmnpqrstvwxz';
    const vowels = 'aeiou';
    let body = '';
    for (let i = 0; i < 3; i++) {
        body += consonants[Math.floor(Math.random() * consonants.length)];
        body += vowels[Math.floor(Math.random() * vowels.length)];
    }
    body += String(Math.floor(10 + Math.random() * 90));
    return (prefix || getUploadNamePrefix()) + body;
}

export function handleFileSelect() {
    const file = fileInput.files[0];
    if (file) {
        const fileInfoDiv = document.getElementById('fileInfo');
        if (fileInfoDiv) {
            fileInfoDiv.classList.remove('hidden');
            fileInfoDiv.innerHTML = `<strong>${escapeHtml(file.name)}</strong> (${(file.size / 1024).toFixed(1)} KB)`;
        }
        uploadSubmitBtn.disabled = false;
        if (!uploadDisplayName.value) {
            uploadDisplayName.value = file.name.replace(/\.[^/.]+$/, '');
        }
        showFilePreview(file);
    } else {
        const fileInfoDiv = document.getElementById('fileInfo');
        if (fileInfoDiv) fileInfoDiv.classList.add('hidden');
        uploadSubmitBtn.disabled = true;
        clearFilePreview();
    }
}

export function clearFilePreview() {
    const area = document.getElementById('dropArea');
    if (area) {
        area.innerHTML = `
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 5v14M5 12h14"/></svg>
            <p>${t('dragDrop')}</p>
        `;
        area.classList.remove('has-preview');
        const thumb = area.querySelector('.captured-thumb');
        if (thumb) thumb.remove();
    }
    if (state.previewFileUrl) {
        URL.revokeObjectURL(state.previewFileUrl);
        state.previewFileUrl = null;
    }
    state.previewPosterDataURL = null;
    state.selectedPosterTime = null;
    state.previewVideoEl = null;
    state.videoMetadata = { width: 0, height: 0, duration: 0 };
}

export function setUploadMode(mode) {
    state.uploadMode = mode === 'import' ? 'import' : 'upload';
    document.querySelectorAll('.upload-mode-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === state.uploadMode);
    });
    const uploadPanel = document.getElementById('uploadModePanel');
    const importPanel = document.getElementById('importModePanel');
    if (uploadPanel) uploadPanel.classList.toggle('hidden', state.uploadMode !== 'upload');
    if (importPanel) importPanel.classList.toggle('hidden', state.uploadMode !== 'import');
    uploadSubmitBtn.textContent = state.uploadMode === 'import' ? t('import') : t('upload');
    uploadSubmitBtn.onclick = state.uploadMode === 'import' ? submitImportWithStages : submitUploadWithStages;
    updateUploadButtonState();
    applyLanguage();
}

export function resetUploadFormKeepMode() {
    fileInfo.classList.add('hidden');
    fileInput.value = '';
    uploadSubmitBtn.disabled = true;
    uploadSubmitBtn.textContent = state.uploadMode === 'import' ? t('import') : t('upload');
    uploadSubmitBtn.onclick = state.uploadMode === 'import' ? submitImportWithStages : submitUploadWithStages;
    const statusEl = document.getElementById('uploadCompleteStatus');
    if (statusEl) {
        statusEl.style.display = 'none';
        statusEl.classList.add('hidden');
    }
    uploadDisplayName.value = '';
    uploadDescription.value = '';
    uploadTagsAddInput.value = '';
    document.getElementById('stagesContainer').innerHTML = '';
    currentProgressElement = null;
    state.uploadTagsList = [];
    renderUploadTagsChips();
    clearFilePreview();
    clearImportPreview();
    state.selectedPosterTime = null;
    state.previewPosterDataURL = null;
    state.importTempId = null;
    state.importMediaType = null;
    state.importOriginalName = '';
    const importUrl = document.getElementById('importUrlInput');
    if (importUrl) importUrl.value = '';
    if (statusPollingInterval) {
        clearInterval(statusPollingInterval);
        statusPollingInterval = null;
    }
    updateUploadButtonState();
    applyLanguage();
}

export function openUploadModal() {
    uploadModal.classList.remove('hidden');
    state.uploadMode = 'upload';
    setUploadMode('upload');
    resetUploadFormKeepMode();
    applyLanguage();
}

export function closeUploadModalFn() {
    uploadModal.classList.add('hidden');
    if (statusPollingInterval) {
        clearInterval(statusPollingInterval);
        statusPollingInterval = null;
    }
    clearProgress();
    clearFilePreview();
    clearImportPreview();
    state.selectedPosterTime = null;
    state.previewPosterDataURL = null;
    state.uploadTagsList = [];
    state.importTempId = null;
    state.importMediaType = null;
    state.importOriginalName = '';
    renderUploadTagsChips();
}

export function clearImportPreview() {
    const area = document.getElementById('importPreviewArea');
    if (area) {
        area.innerHTML = `
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 5v14M5 12h14"/></svg>
            <p>${t('importWaiting')}</p>
        `;
        area.classList.remove('has-preview');
    }
    const info = document.getElementById('importFileInfo');
    if (info) {
        info.classList.add('hidden');
        info.innerHTML = '';
    }
    if (state.importTempId) {
        fetch(`/api/import/${state.importTempId}`, { method: 'DELETE' }).catch(() => {});
    }
    state.importTempId = null;
    state.importMediaType = null;
    state.importOriginalName = '';
    state.previewVideoEl = null;
    state.previewPosterDataURL = null;
    state.selectedPosterTime = null;
    state.videoMetadata = { width: 0, height: 0, duration: 0 };
}

export function showImportPreview(meta) {
    const area = document.getElementById('importPreviewArea');
    if (!area) return;

    state.previewPosterDataURL = null;
    state.selectedPosterTime = null;
    state.previewVideoEl = null;
    state.videoMetadata = {
        width: meta.width || 0,
        height: meta.height || 0,
        duration: 0
    };

    area.innerHTML = '';
    const mediaWrapper = document.createElement('div');
    mediaWrapper.style.cssText = 'width:100%; height:100%; display:flex; align-items:center; justify-content:center; position:relative;';

    const previewUrl = meta.previewUrl || `/api/import/preview/${meta.tempId}`;
    const isVideo = meta.mediaType === 'video';
    const isGif = meta.mediaType === 'gif';
    let mediaElement;

    if (isVideo) {
        mediaElement = document.createElement('video');
        mediaElement.src = previewUrl;
        mediaElement.controls = false;
        mediaElement.autoplay = false;
        mediaElement.muted = true;
        mediaElement.playsInline = true;
        mediaElement.loop = false;
        mediaElement.preload = 'auto';
        mediaElement.crossOrigin = 'use-credentials';
        mediaElement.style.cssText = 'width:100%; height:100%; object-fit:contain; background:#000;';
        mediaWrapper.appendChild(mediaElement);
        state.previewVideoEl = mediaElement;
        mediaElement.addEventListener('loadedmetadata', () => {
            state.videoMetadata.width = mediaElement.videoWidth || meta.width || 0;
            state.videoMetadata.height = mediaElement.videoHeight || meta.height || 0;
            state.videoMetadata.duration = mediaElement.duration || 0;
            try {
                mediaElement.currentTime = (mediaElement.duration > 0.5) ? 0.05 : 0;
            } catch (_) {}
            updateUploadButtonState();
        });
        createVideoPlayer(mediaElement, mediaWrapper, true);
    } else {
        mediaElement = document.createElement('img');
        mediaElement.src = previewUrl;
        mediaElement.alt = meta.originalName || '';
        mediaElement.crossOrigin = 'use-credentials';
        mediaElement.style.cssText = 'width:100%; height:100%; object-fit:contain; background:#000;';
        mediaElement.onload = () => {
            const w = mediaElement.naturalWidth || meta.width || 0;
            const h = mediaElement.naturalHeight || meta.height || 0;
            state.videoMetadata.width = w;
            state.videoMetadata.height = h;
            state.videoMetadata.duration = 0;
            if (isGif) {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = w || 1;
                    canvas.height = h || 1;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(mediaElement, 0, 0, canvas.width, canvas.height);
                    state.previewPosterDataURL = canvas.toDataURL('image/jpeg', 0.85);
                    state.selectedPosterTime = 0;
                } catch (err) {
                    console.warn('GIF poster capture failed:', err);
                }
            }
            updateUploadButtonState();
        };
        mediaWrapper.appendChild(mediaElement);
    }

    area.appendChild(mediaWrapper);
    area.classList.add('has-preview');

    const info = document.getElementById('importFileInfo');
    if (info) {
        info.classList.remove('hidden');
        const sizeKb = ((meta.fileSize || 0) / 1024).toFixed(1);
        info.innerHTML = `<strong>${escapeHtml(meta.originalName || '')}</strong> (${sizeKb} KB) · ${escapeHtml(meta.source || '')}`;
    }

    state.previewFileType = isVideo ? 'video/mp4' : (isGif ? 'image/gif' : 'image/jpeg');
    state.previewFileName = meta.originalName || '';
    updateUploadButtonState();
}

export async function fetchImportFromUrl() {
    const input = document.getElementById('importUrlInput');
    const url = (input?.value || '').trim();
    if (!url) {
        showToast(t('importUrlRequired'), 'error');
        return;
    }
    const btn = document.getElementById('importFetchBtn');
    if (btn) btn.disabled = true;

    if (state.importTempId) {
        clearImportPreview();
    } else {
        const area = document.getElementById('importPreviewArea');
        if (area && !area.classList.contains('has-preview')) {

        }
    }
    showProgress(0);
    try {
        const res = await fetch('/api/import/fetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const raw = await res.text();
        let data;
        try {
            data = raw ? JSON.parse(raw) : {};
        } catch (e) {
            const snippet = (raw || '').slice(0, 120).replace(/\s+/g, ' ');
            throw new Error(
                res.status === 404
                    ? (t('importApiMissing') || 'Import API not found — update server routes.js and import-booru.js')
                    : `Server returned non-JSON (HTTP ${res.status}): ${snippet || '(empty)'}`
            );
        }
        if (!data.success) {
            if (data.code === 'credentials_required' && data.site) {
                clearProgress();
                try {
                    const mod = await import('./auth-settings.js');
                    const saved = await mod.openBooruCredsModal(data.site, data.site);
                    if (saved) {
                        if (btn) btn.disabled = false;
                        return fetchImportFromUrl();
                    }
                } catch (e) {
                    console.error(e);
                }
                showToast(t('credentialsRequired') || data.error, 'error');
                return;
            }
            throw new Error(data.error || t('importError'));
        }
        state.importTempId = data.tempId;
        state.importMediaType = data.mediaType;
        state.importOriginalName = data.originalName;
        state.uploadTagsList = Array.isArray(data.tags) ? [...data.tags] : [];
        renderUploadTagsChips();
        if (!uploadDisplayName.value) {
            uploadDisplayName.value = (data.originalName || '').replace(/\.[^/.]+$/, '');
        }
        showImportPreview(data);
        clearProgress();
        showToast(t('importFetched'), 'success');
    } catch (err) {
        console.error('Import fetch error:', err);
        showToast((t('importError') || 'Import error') + ': ' + err.message, 'error');
        clearProgress();
        clearImportPreview();
    } finally {
        if (btn) btn.disabled = false;
        updateUploadButtonState();
    }
}

export async function submitImportWithStages() {
    if (!state.importTempId) return;

    const isVideo = state.importMediaType === 'video';
    const isGif = state.importMediaType === 'gif';

    if (isVideo && state.previewVideoEl) {
        const video = state.previewVideoEl;
        const w = video.videoWidth || 0;
        const h = video.videoHeight || 0;
        if (!w || !h) {
            showToast(t('posterRequired') || 'Wait for video', 'error');
            return;
        }
        try {
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, w, h);
            state.previewPosterDataURL = canvas.toDataURL('image/jpeg', 0.85);
            state.selectedPosterTime = video.currentTime || 0;
        } catch (err) {
            console.error('Capture at import submit failed:', err);
            showToast(t('posterRequired') || 'Could not capture frame', 'error');
            return;
        }
    }

    if ((isVideo || isGif) && !state.previewPosterDataURL) {
        showToast(t('posterRequired') || 'Please wait for preview', 'error');
        return;
    }

    uploadSubmitBtn.disabled = true;
    const container = document.getElementById('stagesContainer');
    if (container) container.innerHTML = '';
    currentProgressElement = null;
    const statusEl = document.getElementById('uploadCompleteStatus');
    if (statusEl) {
        statusEl.style.display = 'none';
        statusEl.classList.add('hidden');
    }

    updateProgress(30);

    let commitResult;
    try {
        const res = await fetch('/api/import/commit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tempId: state.importTempId,
                displayName: uploadDisplayName.value,
                description: uploadDescription.value,
                tags: state.uploadTagsList.join(' '),
                posterData: state.previewPosterDataURL || null,
                posterTime: state.selectedPosterTime !== null ? String(state.selectedPosterTime) : '0',
                width: String(state.videoMetadata.width || 0),
                height: String(state.videoMetadata.height || 0),
                duration: isVideo ? String(state.videoMetadata.duration || 0) : '0'
            })
        });
        commitResult = await res.json();
        if (!commitResult.success) {
            throw new Error(commitResult.error || 'Commit failed');
        }
        state.importTempId = null;
        updateProgress(100);
    } catch (err) {
        console.error('Import commit error:', err);
        showToast((t('importError') || 'Import error') + ': ' + err.message, 'error');
        uploadSubmitBtn.disabled = false;
        clearProgress();
        return;
    }

    const hash = commitResult.hash;
    if (statusPollingInterval) clearInterval(statusPollingInterval);
    statusPollingInterval = setInterval(async () => {
        try {
            const statusResponse = await fetch(`/api/status?hash=${hash}`);
            const status = await statusResponse.json();

            if (status.stage === 'error') {
                clearInterval(statusPollingInterval);
                statusPollingInterval = null;
                showToast(t('processingError') + ': ' + status.message, 'error');
                uploadSubmitBtn.disabled = false;
                clearProgress();
                return;
            }

            let progress = 0;
            if (status.stage === 'container') {
                progress = Math.min(70, status.progress || 0);
            } else if (status.stage === 'database') {
                progress = 70 + Math.min(30, status.progress || 0);
            } else if (status.stage === 'done') {
                clearInterval(statusPollingInterval);
                statusPollingInterval = null;
                clearProgress();
                const doneEl = document.getElementById('uploadCompleteStatus');
                if (doneEl) {
                    doneEl.style.display = 'block';
                    doneEl.classList.remove('hidden');
                }
                uploadSubmitBtn.textContent = t('uploadMore');
                uploadSubmitBtn.disabled = false;
                uploadSubmitBtn.onclick = function() {
                    resetUploadFormKeepMode();
                };
                loadMedia(0);
                showToast(t('uploadComplete'), 'success');
                return;
            }
            updateProgress(progress);
        } catch (err) {
            console.error('Status polling error:', err);
        }
    }, 500);
}

export function renderUploadTagsChips() {
    if (!uploadTagsContainer) return;
    uploadTagsContainer.innerHTML = '';
    if (!state.uploadTagsList || state.uploadTagsList.length === 0) {
        uploadTagsContainer.innerHTML = `<div class="empty-state" style="font-size:12px; color:var(--muted);">${t('noTags')}</div>`;
        return;
    }
    state.uploadTagsList.forEach(tag => {
        const chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.innerHTML = `${escapeHtml(tag)} <span class="tag-remove" data-tag="${escapeHtml(tag)}">${icons.close}</span>`;
        chip.style.cursor = 'pointer';
        const removeBtn = chip.querySelector('.tag-remove');
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tagToRemove = removeBtn.dataset.tag;
            state.uploadTagsList = state.uploadTagsList.filter(t => t !== tagToRemove);
            renderUploadTagsChips();
        });
        uploadTagsContainer.appendChild(chip);
    });
}

export function addUploadTag(tag) {
    if (!tag) return;
    tag = tag.trim();
    if (!tag) return;
    if (state.uploadTagsList.includes(tag)) return;
    state.uploadTagsList.push(tag);
    renderUploadTagsChips();
    uploadTagsAddInput.value = '';
    suggestions.classList.remove('show');
    selectedSuggestionIndex = -1;
}

export function computeHashWithProgress(file, onProgress) {
    return new Promise((resolve, reject) => {
        const blobSlice = File.prototype.slice || File.prototype.mozSlice || File.prototype.webkitSlice;
        const chunkSize = 1024 * 1024 * 2;
        const chunks = Math.ceil(file.size / chunkSize);
        let currentChunk = 0;
        const spark = new SparkMD5.ArrayBuffer();
        const fileReader = new FileReader();
        fileReader.onload = function(e) {
            spark.append(e.target.result);
            currentChunk++;
            if (currentChunk < chunks) {
                const percent = Math.round((currentChunk / chunks) * 100);
                onProgress(percent);
                loadNext();
            } else {
                onProgress(100);
                resolve(spark.end());
            }
        };
        fileReader.onerror = function() {
            reject(new Error('File read error'));
        };
        function loadNext() {
            const start = currentChunk * chunkSize;
            const end = Math.min(start + chunkSize, file.size);
            fileReader.readAsArrayBuffer(blobSlice.call(file, start, end));
        }
        loadNext();
    });
}

export async function submitUploadWithStages() {
    const file = fileInput.files[0];
    if (!file) return;

    const isVideo = file.type.startsWith('video/');
    const isGif = file.type === 'image/gif';

    if (isVideo && state.previewVideoEl) {
        const video = state.previewVideoEl;
        const w = video.videoWidth || 0;
        const h = video.videoHeight || 0;
        if (!w || !h) {
            showToast(t('posterRequired') || 'Дождитесь загрузки видео', 'error');
            return;
        }
        try {
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, w, h);
            state.previewPosterDataURL = canvas.toDataURL('image/jpeg', 0.85);
            state.selectedPosterTime = video.currentTime || 0;
            console.log('[poster] captured at submit, time=', state.selectedPosterTime, 'size=', Math.round(state.previewPosterDataURL.length / 1024), 'KB');
        } catch (err) {
            console.error('Capture at submit failed:', err);
            showToast(t('posterRequired') || 'Не удалось захватить кадр', 'error');
            return;
        }
    }

    if ((isVideo || isGif) && !state.previewPosterDataURL) {
        showToast(t('posterRequired') || 'Пожалуйста, дождитесь загрузки превью', 'error');
        return;
    }

    uploadSubmitBtn.disabled = true;
    const container = document.getElementById('stagesContainer');
    container.innerHTML = '';
    currentProgressElement = null;
    const statusEl = document.getElementById('uploadCompleteStatus');
    if (statusEl) statusEl.style.display = 'none';

    updateProgress(0);
    let fileHash;
    try {
        fileHash = await computeHashWithProgress(file, (percent) => {
            updateProgress(percent);
        });
        updateProgress(100);
    } catch (err) {
        console.error('Hashing error:', err);
        showToast(t('hashError') + ': ' + err.message, 'error');
        uploadSubmitBtn.disabled = false;
        clearProgress();
        return;
    }

    updateProgress(0);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('displayName', uploadDisplayName.value);
    formData.append('description', uploadDescription.value);
    formData.append('tags', state.uploadTagsList.join(' '));
    formData.append('mediaType', 'auto');
    formData.append('posterTime', state.selectedPosterTime !== null ? String(state.selectedPosterTime) : '0');
    if (state.previewPosterDataURL) {
        formData.append('posterData', state.previewPosterDataURL);
    }
    formData.append('width', String(state.videoMetadata.width || 0));
    formData.append('height', String(state.videoMetadata.height || 0));
    if (isVideo) {
        formData.append('duration', String(state.videoMetadata.duration || 0));
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload', true);
    xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            updateProgress(percent);
        }
    });

    const uploadPromise = new Promise((resolve, reject) => {
        xhr.onload = () => {
            if (xhr.status === 200) {
                try { resolve(JSON.parse(xhr.responseText)); } catch(e) { reject(new Error('Invalid response')); }
            } else {
                reject(new Error(`Server error: ${xhr.status}`));
            }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(formData);
    });

    let uploadResult;
    try {
        uploadResult = await uploadPromise;
        updateProgress(100);
    } catch (err) {
        console.error('Upload error:', err);
        showToast(t('uploadError') + ': ' + err.message, 'error');
        uploadSubmitBtn.disabled = false;
        clearProgress();
        return;
    }

    const hash = uploadResult.hash;
    if (!hash) {
        showToast(t('uploadError'), 'error');
        uploadSubmitBtn.disabled = false;
        clearProgress();
        return;
    }

    try {
        const processResponse = await fetch('/api/process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hash })
        });
        const processData = await processResponse.json();
        if (!processData.success) {
            throw new Error(processData.error || 'Process start failed');
        }
    } catch (err) {
        console.error('Process start error:', err);
        showToast(t('processStartError') + ': ' + err.message, 'error');
        uploadSubmitBtn.disabled = false;
        clearProgress();
        return;
    }

    if (statusPollingInterval) clearInterval(statusPollingInterval);
    statusPollingInterval = setInterval(async () => {
        try {
            const statusResponse = await fetch(`/api/status?hash=${hash}`);
            const status = await statusResponse.json();

            if (status.stage === 'error') {
                clearInterval(statusPollingInterval);
                statusPollingInterval = null;
                showToast(t('processingError') + ': ' + status.message, 'error');
                uploadSubmitBtn.disabled = false;
                clearProgress();
                return;
            }

            let progress = 0;
            if (status.stage === 'container') {
                progress = status.progress || 0;
                progress = Math.min(70, progress);
            } else if (status.stage === 'database') {
                progress = status.progress || 0;
                progress = 70 + Math.min(30, progress);
            } else if (status.stage === 'done') {
                clearInterval(statusPollingInterval);
                statusPollingInterval = null;
                clearProgress();
                const statusEl = document.getElementById('uploadCompleteStatus');
                if (statusEl) {
                    statusEl.style.display = 'block';
                    statusEl.classList.remove('hidden');
                }
                uploadSubmitBtn.textContent = t('uploadMore');
                uploadSubmitBtn.disabled = false;
                uploadSubmitBtn.onclick = function() {
                    resetUploadFormKeepMode();
                };
                loadMedia(0);
                showToast(t('uploadComplete'), 'success');
                return;
            }

            updateProgress(progress);

        } catch (err) {
            console.error('Status polling error:', err);
        }
    }, 500);
}
