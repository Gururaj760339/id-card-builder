/**
 * Entry point for the read only pages: saved template thumbnails and the
 * template preview page.
 */

import { renderPageScenes } from './render.js';

function boot() {
    renderPageScenes({ maxWidth: 760, maxHeight: 900 }).catch((error) => {
        console.error('[id-card] preview render failed', error);
    });

    let resizeTimer = null;

    window.addEventListener('resize', () => {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
            renderPageScenes({ maxWidth: 760, maxHeight: 900 }).catch(() => {});
        }, 300);
    });

    initConfirmDialogs();
}

/**
 * Ask for an explicit confirmation before any destructive form submission.
 */
function initConfirmDialogs() {
    const dialog = document.querySelector('[data-role="confirm-dialog"]');

    if (!dialog) {
        return;
    }

    const text = dialog.querySelector('[data-role="confirm-text"]');
    let pending = null;

    document.addEventListener('submit', (event) => {
        const form = event.target.closest('[data-confirm]');

        if (!form || pending) {
            return;
        }

        event.preventDefault();
        pending = form;
        text.textContent = form.dataset.confirm;
        dialog.showModal();
    });

    dialog.querySelector('[data-action="confirm-cancel"]').addEventListener('click', () => {
        pending = null;
        dialog.close();
    });

    dialog.querySelector('[data-action="confirm-accept"]').addEventListener('click', () => {
        const form = pending;

        pending = null;
        dialog.close();

        if (form) {
            form.removeAttribute('data-confirm');
            form.submit();
        }
    });
}

document.addEventListener('DOMContentLoaded', boot);