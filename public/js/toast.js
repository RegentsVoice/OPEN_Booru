export function showToast(message, type = 'info', duration = 4000) {
    const key = `${type}::${String(message || '')}`;
    const now = Date.now();
    if (!showToast._recent) showToast._recent = new Map();
    const prev = showToast._recent.get(key) || 0;
    if (now - prev < 2500) return;
    showToast._recent.set(key, now);
    if (showToast._recent.size > 40) {
        for (const [k, ts] of showToast._recent) {
            if (now - ts > 5000) showToast._recent.delete(k);
        }
    }

    const container = document.getElementById('toastContainer') || createToastContainer();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

function createToastContainer() {
    const div = document.createElement('div');
    div.id = 'toastContainer';
    document.body.appendChild(div);
    return div;
}
