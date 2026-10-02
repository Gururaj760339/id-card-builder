/**
 * Read only renderer shared by the template list thumbnails, the preview page
 * and the builder's preview dialog.
 */

import { createCanvas, loadScene } from './scene.js';
import { renderMaskedBackground } from './mask.js';
import { clamp } from './schema.js';

let fontsReady = null;

/**
 * Load a design bitmap, so flattened artwork can be re-rendered with its erased
 * regions inpainted out before it is handed to the renderer.
 */
function loadImage(src) {
    return new Promise((resolve, reject) => {
        if (!src) {
            reject(new Error('Missing image source.'));

            return;
        }

        const image = new Image();

        image.onload = () => (image.naturalWidth > 0 && image.naturalHeight > 0
            ? resolve(image)
            : reject(new Error('The design image is empty.')));
        image.onerror = () => reject(new Error('The design image could not be loaded.'));
        image.src = src;
    });
}

/**
 * Apply the scene's masks to the stored design image.
 *
 * Without this a saved template would reopen - and re-download as a thumbnail -
 * with the original lettering visible underneath the editable layers, which is
 * exactly the duplicate the editor is supposed to prevent.
 */
async function maskedBackgroundSrc(scene, card) {
    const src = scene?.background?.src;

    if (!src || !Array.isArray(scene.masks) || scene.masks.length === 0) {
        return src ?? null;
    }

    try {
        const masked = renderMaskedBackground(await loadImage(src), card, scene.masks);

        return masked ? masked.toDataURL('image/png') : src;
    } catch (error) {
        return src;
    }
}

/**
 * Wait for the web fonts so canvas text metrics match the editor.
 */
export function waitForFonts() {
    if (!fontsReady) {
        fontsReady = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    }

    return fontsReady;
}

/**
 * Read the JSON scene embedded next to a container.
 */
export function readScene(container) {
    const script = container.querySelector('[data-role="scene"]');

    if (!script) {
        return null;
    }

    try {
        return JSON.parse(script.textContent || 'null');
    } catch (error) {
        return null;
    }
}

/**
 * Render one side of a card into a container element.
 */
export async function renderSceneInto(container, scene, options = {}) {
    if (!container || !scene) {
        return null;
    }

    const card = scene.card ?? { width: 1011, height: 638 };
    const padding = options.padding ?? 16;
    const maxWidth = options.maxWidth ?? 720;
    const maxHeight = options.maxHeight ?? 720;
    const zoom = options.zoom ?? clamp(Math.min((maxWidth - padding) / card.width, (maxHeight - padding) / card.height), 0.05, 2);

    container.replaceChildren();

    const canvasElement = document.createElement('canvas');

    canvasElement.setAttribute('role', 'img');
    canvasElement.setAttribute('aria-label', options.label || 'ID card design');
    container.appendChild(canvasElement);

    const canvas = createCanvas(canvasElement, { selection: false });

    await waitForFonts();

    await loadScene(canvas, scene, {
        interactive: false,
        zoom,
        backgroundSrc: await maskedBackgroundSrc(scene, card),
        data: options.data ?? {},
        fields: options.fields ?? [],
    });

    return canvas;
}

/**
 * Render every `[data-scene-preview]` / `[data-thumb]` block on the page.
 */
export function renderPageScenes({ maxWidth = 720, maxHeight = 720, threshold = 0.2 } = {}) {
    const targets = Array.from(document.querySelectorAll('[data-scene-preview], [data-thumb]'));

    if (!('IntersectionObserver' in window)) {
        return Promise.all(targets.map((node) => renderNode(node, maxWidth, maxHeight)));
    }

    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (!entry.isIntersecting) {
                return;
            }

            observer.unobserve(entry.target);
            renderNode(entry.target, maxWidth, maxHeight);
        });
    }, { rootMargin: '200px', threshold });

    targets.forEach((node) => observer.observe(node));

    return Promise.resolve();
}

/**
 * Render a single container that holds an embedded scene.
 */
export function renderNode(node, maxWidth, maxHeight) {
    const scene = readScene(node);

    if (!scene) {
        node.classList.add('idc-thumb--empty');

        return Promise.resolve(null);
    }

    return renderSceneInto(node, scene, {
        maxWidth: node.dataset.label ? maxWidth : maxWidth,
        maxHeight,
        label: node.dataset.label || undefined,
    });
}