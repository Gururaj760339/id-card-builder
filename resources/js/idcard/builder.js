/**
 * ID Card Builder editor.
 *
 * A real visual editor on top of Fabric.js: the uploaded front / back design
 * image is the (never modified) background, everything the user adds is a
 * serialization friendly layer, and the whole state is saved to / restored from
 * the id_card_templates table.
 */

import {
    applyCardSize,
    buildBackground,
    buildElementObject,
    buildRegionDraft,
    buildRegionGuide,
    configureFabric,
    createCanvas,
    loadScene,
    replaceElementObject,
    syncGeometry,
} from './scene.js';

import { renderSceneInto, waitForFonts } from './render.js';

import { renderMaskedBackground, sampleRegionColours } from './mask.js';

import { detectDesignRegions, dropDuplicateRegions, partitionRegions, pendingRegions } from './detect.js';

import {
    BARCODE_FORMATS,
    ELEMENT_LABELS,
    FITS,
    FRAMES,
    IMAGE_TYPES,
    MAX_ELEMENTS,
    MAX_MASKS,
    TEXT_TYPES,
    TRANSFORMS,
    clamp,
    defaultElement,
    emptyScene,
    keyFromLabel,
    normalizeKey,
    normalizeMask,
    normalizeScene,
    round,
    uid,
} from './schema.js';

/* -------------------------------------------------------------------------
 | State
 ---------------------------------------------------------------------- */

const config = JSON.parse(document.getElementById('idc-config')?.textContent || '{}');
const root = document.getElementById('idc-app');

const state = {
    side: 'front',
    scenes: {
        front: emptyScene(config.card),
        back: emptyScene(config.card),
    },
    selectedId: null,
    zoomMode: 'fit',
    zoom: 1,
    fields: [],
    name: config.templateName || '',
    status: 'active',
    dirty: false,
    saving: false,
    pendingAssetKind: 'custom',
    replaceTargetId: null,
    pendingAssetRect: null,
    // The pristine uploaded bitmap per side. Every editable region is cut out
    // of this original, never out of the previous masked result, so removing a
    // mask always restores the untouched artwork.
    sources: { front: null, back: null },
    // Content rectangles found in the uploaded design that have not been turned
    // into layers yet.
    regions: { front: [], back: [] },
    showRegions: true,
    regionMode: false,
};

const elements = {};

let canvas = null;
let alertTimer = null;
let sideLoadQueue = Promise.resolve();
let backgroundQueue = Promise.resolve();
let regionDraft = null;
let regionOrigin = null;
const maskedCache = { front: null, back: null };

const ICONS = {
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 6.3A9.7 9.7 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.4 4M6.3 6.8A16.6 16.6 0 0 0 2 12s3.6 6 10 6a9.9 9.9 0 0 0 3.7-.7"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    unlock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.6-1.7"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    down: '<path d="M12 5v14M5 12l7 7 7-7"/>',
    front: '<rect x="3" y="3" width="12" height="12" rx="2"/><path d="M9 21h10a2 2 0 0 0 2-2V9"/>',
    back: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>',
};

/* -------------------------------------------------------------------------
 | Small helpers
 ---------------------------------------------------------------------- */

function qs(selector, scope = document) {
    return scope.querySelector(selector);
}

function qsa(selector, scope = document) {
    return Array.from(scope.querySelectorAll(selector));
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function icon(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function hexColor(value, fallback = '#000000') {
    if (typeof value !== 'string') {
        return fallback;
    }

    const color = value.trim();

    if (/^#[0-9a-f]{6}$/i.test(color)) {
        return color.toLowerCase();
    }

    if (/^#[0-9a-f]{3}$/i.test(color)) {
        return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`.toLowerCase();
    }

    const rgba = color.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);

    if (rgba) {
        const toHex = (part) => clamp(parseInt(part, 10), 0, 255).toString(16).padStart(2, '0');

        return `#${toHex(rgba[1])}${toHex(rgba[2])}${toHex(rgba[3])}`;
    }

    return fallback;
}

function csrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.content || '';
}

function currentScene() {
    return state.scenes[state.side];
}

function currentCard() {
    return currentScene().card;
}

function fieldCatalog() {
    return state.fields;
}

function findElement(id) {
    return currentScene().elements.find((element) => element.id === id) || null;
}

function objectFor(id) {
    return canvas?.getObjects().find((object) => object.idcard?.id === id && object.idcard.role !== 'background') || null;
}

function selectedObject() {
    const active = canvas?.getActiveObject();

    if (active?.idcard?.id && active.idcard.role !== 'background') {
        return active;
    }

    return state.selectedId ? objectFor(state.selectedId) : null;
}

function selectedElement() {
    const object = selectedObject();

    if (object) {
        return findElement(object.idcard.id);
    }

    return state.selectedId ? findElement(state.selectedId) : null;
}

function backgroundObject() {
    return canvas?.getObjects().find((object) => object.idcard?.role === 'background') || null;
}

function isTypingTarget(target) {
    if (!target) {
        return false;
    }

    const tag = target.tagName?.toLowerCase();

    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

function markDirty() {
    state.dirty = true;
}

/* -------------------------------------------------------------------------
 | Boot
 ---------------------------------------------------------------------- */

async function boot() {
    cacheElements();
    buildFieldCatalog();
    configureFabric();
    bindEvents();

    canvas = createCanvas(elements.canvas, { selection: true, preserveObjectStacking: true });

    bindCanvasEvents();

    if (config.frontScene || config.backScene) {
        state.scenes.front = prepareStoredScene(config.frontScene, 'front');
        state.scenes.back = prepareStoredScene(config.backScene, 'back');
    }

    applyCardToInputs();
    renderCustomFieldChips();
    updateDesignStates();

    await hydrateSources();

    await waitForFonts();
    await loadSide(state.side);
    await detectRegions({ silent: true });

    root.dataset.ready = 'true';
}

function cacheElements() {
    Object.assign(elements, {
        canvas: qs('#idc-canvas'),
        stageScroll: qs('[data-role="stage-scroll"]'),
        canvasWrap: qs('[data-role="canvas-wrap"]'),
        alert: qs('[data-role="alert"]'),
        sideBadge: qs('[data-role="side-badge"]'),
        canvasMeta: qs('[data-role="canvas-meta"]'),
        zoomLabel: qs('[data-role="zoom-label"]'),
        propertiesPanel: qs('[data-role="properties-panel"]'),
        layersPanel: qs('[data-role="layers-panel"]'),
        cardWidth: qs('[data-role="card-width"]'),
        cardHeight: qs('[data-role="card-height"]'),
        cardOrientation: qs('[data-role="card-orientation"]'),
        cardHint: qs('[data-role="card-hint"]'),
        frontState: qs('[data-role="front-state"]'),
        backState: qs('[data-role="back-state"]'),
        customFields: qs('[data-role="custom-fields"]'),
        customLabel: qs('[data-role="custom-label"]'),
        customKey: qs('[data-role="custom-key"]'),
        fileFront: qs('[data-role="file-front"]'),
        fileBack: qs('[data-role="file-back"]'),
        fileAsset: qs('[data-role="file-asset"]'),
        saveDialog: qs('[data-role="save-dialog"]'),
        saveForm: qs('[data-role="save-form"]'),
        saveName: qs('[data-role="save-name"]'),
        saveStatus: qs('[data-role="save-status"]'),
        saveErrors: qs('[data-role="save-errors"]'),
        saveTitle: qs('[data-role="save-title"]'),
        previewDialog: qs('[data-role="preview-dialog"]'),
        previewFront: qs('[data-role="preview-front"]'),
        previewBack: qs('[data-role="preview-back"]'),
        regionState: qs('[data-role="region-state"]'),
        stageHint: qs('[data-role="stage-hint"]'),
        modeLabel: qs('[data-role="mode-label"]'),
    });
}

/**
 * Turn a scene coming from the server into the editable store shape.
 */
function prepareStoredScene(scene, side) {
    const normalized = normalizeScene(scene ?? {}, config.card);

    return {
        card: normalized.card,
        background: {
            src: scene?.background?.src ?? null,
            file: null,
            visible: normalized.background.visible,
        },
        custom_fields: normalized.custom_fields,
        elements: normalized.elements,
        masks: normalized.masks,
        side,
    };
}

function buildFieldCatalog() {
    state.fields = [];

    const add = (field, custom = false) => {
        const existing = state.fields.find((item) => item.key === field.key);

        if (existing) {
            existing.label = field.label;
            existing.custom = existing.custom || custom;

            return;
        }

        state.fields.push({ key: field.key, label: field.label, custom });
    };

    Object.values(config.dynamicFields || {}).forEach((group) => {
        group.forEach((field) => add(field));
    });

    ['front', 'back'].forEach((side) => {
        (config[`${side}Scene`]?.custom_fields || []).forEach((field) => add(field, true));
    });

    state.fields.sort((a, b) => Number(Boolean(b.custom)) - Number(Boolean(a.custom)) || a.label.localeCompare(b.label));
}

function applyCardToInputs() {
    const card = currentCard();

    elements.cardWidth.value = card.width;
    elements.cardHeight.value = card.height;
    elements.cardOrientation.value = card.orientation;
}

/* -------------------------------------------------------------------------
 | Canvas + side handling
  ---------------------------------------------------------------------- */

/**
 * The picture the card background is built from.
 *
 * With no erased regions this is the uploaded file untouched. Once the user has
 * turned content into editable layers, the very same pixels are re-rendered with
 * those rectangles inpainted out, which is what makes editing, moving and
 * deleting real: the flattened lettering underneath can no longer show through.
 */
function backgroundSource(side) {
    const scene = state.scenes[side];
    const source = state.sources[side];
    const fallback = scene.background.src;

    if (!source || !scene.masks?.length) {
        return fallback;
    }

    const key = `${scene.card.width}x${scene.card.height}:${scene.masks
        .map((mask) => `${mask.id}@${mask.left},${mask.top},${mask.width},${mask.height}`)
        .join('|')}`;

    if (maskedCache[side]?.key === key) {
        return maskedCache[side].url;
    }

    let masked = null;

    try {
        masked = renderMaskedBackground(source, scene.card, scene.masks);
    } catch (error) {
        // A masking failure must never take the editor down with it: show the
        // untouched upload instead so the user can keep working and retry.
        console.error('[id-card] artwork could not be masked', error);
        invalidateMaskedBackground(side);

        return fallback;
    }

    if (!masked) {
        return fallback;
    }

    maskedCache[side] = { key, url: masked.toDataURL('image/png') };

    return maskedCache[side].url;
}

/**
 * Forget the cached masked bitmap of a side.
 */
function invalidateMaskedBackground(side) {
    maskedCache[side] = null;
}

/**
 * Load an <img> from a URL (used for designs that come back from the server).
 */
function loadImageFromUrl(src) {
    return new Promise((resolve, reject) => {
        if (!src) {
            reject(new Error('Missing image source.'));

            return;
        }

        const image = new Image();

        image.onload = () => {
            if (!(image.naturalWidth > 0) || !(image.naturalHeight > 0)) {
                reject(new Error('The image could not be loaded.'));

                return;
            }

            resolve(image);
        };
        image.onerror = () => reject(new Error('The image could not be loaded.'));
        image.src = src;
    });
}

/**
 * Give both sides their pristine bitmap back so stored masks can be re-applied.
 *
 * Without this a saved template would reopen showing the raw artwork with holes
 * nowhere, and every layer would sit on top of its own original.
 */
async function hydrateSources() {
    await Promise.all(['front', 'back'].map(async (side) => {
        const src = state.scenes[side].background?.src;

        if (!src || src.startsWith('blob:')) {
            return;
        }

        try {
            state.sources[side] = await loadImageFromUrl(src);
            invalidateMaskedBackground(side);
        } catch (error) {
            state.sources[side] = null;
        }
    }));
}

/**
 * Swap in a freshly masked background without disturbing the layer stack.
 */
async function refreshBackground(side = state.side) {
    const scene = state.scenes[side];

    invalidateMaskedBackground(side);

    if (!canvas || side !== state.side || !state.sources[side] || !scene.background.src) {
        return;
    }

    const current = backgroundObject();

    if (!current) {
        return;
    }

    const index = canvas.getObjects().indexOf(current);
    const masked = await buildBackground(backgroundSource(side), scene.card);

    if (!masked) {
        return;
    }

    canvas.remove(current);

    if (index >= 0) {
        canvas.insertAt(masked, index);
    } else {
        canvas.insertAt(masked, 0);
    }

    canvas.requestRenderAll();
}

/**
 * Re-render the masked artwork after a change that does not have to be awaited,
 * such as deleting a layer that owned a mask.
 *
 * Re-inpainting the bitmap is asynchronous, so the refreshes are queued: without
 * this, two changes in a row could resolve out of order and leave the background
 * showing artwork that the latest set of masks has already erased.
 */
function scheduleBackgroundRefresh(side = state.side) {
    backgroundQueue = backgroundQueue
        .then(() => refreshBackground(side))
        .catch((error) => console.error('[id-card] artwork could not be re-masked', error));

    return backgroundQueue;
}

/**
 * Draw a side of the card onto the shared canvas.
 */
async function renderSide(side) {
    const scene = state.scenes[side];

    state.zoom = currentZoom(scene.card);

    await loadScene(canvas, scene, {
        interactive: true,
        zoom: state.zoom,
        backgroundSrc: backgroundSource(side),
        data: {},
        fields: fieldCatalog(),
    });

    if (state.side !== side) {
        return;
    }

    state.selectedId = null;
    canvas.discardActiveObject();
    elements.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
    renderRegionGuides();
    renderLayers();
    renderProperties();
    updateStageMeta(scene);
    updateRegionState();
}

/**
 * Load a side, one at a time.
 *
 * Both sides share a single canvas and loading is asynchronous (the base design
 * has to be decoded first), so the user can switch sides, upload another design
 * or resize the card while a load is still running. Queueing the loads and
 * dropping stale results guarantees the canvas always ends up showing the
 * selected side, so a slow front load can never leave front layers on screen
 * while the back side is being edited.
 */
function loadSide(side) {
    sideLoadQueue = sideLoadQueue.then(() => renderSide(side), () => renderSide(side));

    return sideLoadQueue;
}

function currentZoom(card = currentCard()) {
    return state.zoomMode === 'fit' ? fitZoom(card) : state.zoom;
}

function fitZoom(card = currentCard()) {
    const box = elements.stageScroll.getBoundingClientRect();
    const available = {
        width: Math.max(box.width - 56, 160),
        height: Math.max(box.height - 56, 160),
    };

    return clamp(Math.min(available.width / card.width, available.height / card.height), 0.08, 4);
}

function applyZoom() {
    const scene = currentScene();

    state.zoom = currentZoom(scene.card);
    applyCardSize(canvas, scene.card, state.zoom);
    canvas.renderAll();
    elements.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
    updateStageMeta(scene);
}

function updateStageMeta(scene = currentScene()) {
    elements.sideBadge.textContent = state.side.toUpperCase();
    elements.canvasMeta.textContent = `${scene.card.width} × ${scene.card.height} px · ${scene.elements.length} layer${scene.elements.length === 1 ? '' : 's'}`;
}

async function switchSide(side) {
    if (!side || side === state.side) {
        return;
    }

    state.side = side;
    state.selectedId = null;

    if (state.regionMode) {
        setRegionMode(false);
    }

    qsa('[data-action="set-side"]').forEach((button) => {
        const active = button.dataset.side === side;

        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    applyCardToInputs();
    updateDesignStates();
    renderCustomFieldChips();
    await loadSide(side);
}

/* -------------------------------------------------------------------------
 | Element creation
 ---------------------------------------------------------------------- */

function centeredPosition(width, height) {
    const card = currentCard();

    return {
        left: round(Math.max((card.width - width) / 2, 8), 2),
        top: round(Math.max((card.height - height) / 2, 8), 2),
    };
}

/**
 * Build a new element of the given type, centred on the card with a small
 * cascade so successive layers never hide each other.
 */
function buildElement(type, overrides = {}) {
    const card = currentCard();
    const presets = {
        terms: { width: Math.round(card.width * 0.62), height: Math.round(card.height * 0.42), fontSize: 13 },
        barcode: { width: Math.round(card.width * 0.4), height: 110 },
        qrcode: { width: Math.round(card.width * 0.17), height: Math.round(card.width * 0.17) },
        cover: { width: Math.round(card.width * 0.34), height: Math.round(card.height * 0.08) },
    };

    const base = defaultElement(type, { ...(presets[type] || {}), ...overrides });

    if (overrides.left !== undefined) {
        base.left = round(overrides.left, 2);
    }

    if (overrides.top !== undefined) {
        base.top = round(overrides.top, 2);
    } else {
        const center = centeredPosition(base.width, base.height);
        const offset = (currentScene().elements.length % 8) * 18;

        base.left = round(center.left + offset - 60, 2);
        base.top = round(center.top + offset - 40, 2);
    }

    return base;
}

async function addElement(element, { select = true } = {}) {
    const scene = currentScene();

    if (scene.elements.length >= MAX_ELEMENTS) {
        showAlert(`A card side can hold up to ${MAX_ELEMENTS} layers.`);

        return null;
    }

    scene.elements.push(element);

    let object = null;

    try {
        object = await buildElementObject(element, { interactive: true, fields: fieldCatalog() });
    } catch (error) {
        console.error('[id-card] element could not be created', error);
    }

    if (!object) {
        scene.elements = scene.elements.filter((candidate) => candidate.id !== element.id);
        showAlert('This element has no usable image or content and was not added.');

        return null;
    }

    canvas.add(object);

    canvas.requestRenderAll();
    markDirty();
    renderLayers();
    updateStageMeta(scene);

    if (select) {
        selectObject(object);
    }

    return object;
}

async function addDynamicField(key, label) {
    const field = { key, label: label || key.replace(/_/g, ' ') };
    const element = buildElement('dynamic_text', {
        name: field.label,
        field: field.key,
        placeholder: field.label,
        width: Math.min(320, Math.round(currentCard().width * 0.4)),
        fontSize: 22,
    });

    return addElement(element);
}

/**
 * Remember a user defined field on both sides and in the catalog.
 */
function registerCustomField(label, key) {
    ['front', 'back'].forEach((side) => {
        const scene = state.scenes[side];

        if (!scene.custom_fields.some((field) => field.key === key)) {
            scene.custom_fields.push({ key, label });
        }
    });

    const existing = fieldCatalog().find((field) => field.key === key);

    if (existing) {
        existing.label = label;
        existing.custom = true;
    } else {
        state.fields.push({ key, label, custom: true });
    }

    renderCustomFieldChips();
    markDirty();
}

function readCustomFieldInput() {
    const label = elements.customLabel.value.trim();
    const key = normalizeKey(elements.customKey.value) || keyFromLabel(label);

    if (!label || !key) {
        showAlert('Enter a field name (for example "Guardian Name"); the key is generated for you.');

        return null;
    }

    return { label, key };
}

async function createCustomField() {
    const input = readCustomFieldInput();

    if (!input) {
        return;
    }

    registerCustomField(input.label, input.key);
    await addDynamicField(input.key, input.label);

    elements.customLabel.value = '';
    elements.customKey.value = '';
}

async function insertCustomField() {
    const input = readCustomFieldInput();

    if (!input) {
        return;
    }

    registerCustomField(input.label, input.key);
    await addDynamicField(input.key, input.label);
}

/**
 * The "replace existing text" workflow.
 *
 * Text inside a JPG/PNG is flattened pixels: a cover layer hides it and an
 * editable dynamic field is placed exactly on top of the same area.
 */
async function replaceExistingText() {
    const selected = selectedElement();
    const card = currentCard();
    const useSelection = selected && TEXT_TYPES.includes(selected.type);
    const width = useSelection ? selected.width : Math.round(card.width * 0.36);
    const height = useSelection ? Math.max(selected.height, 36) : Math.round(card.height * 0.09);
    const position = useSelection
        ? { left: selected.left, top: selected.top }
        : centeredPosition(width, height);

    const cover = await addElement(buildElement('cover', {
        name: 'Cover / Erase Area',
        bg: '#ffffff',
        radius: 2,
        width,
        height,
        ...position,
    }), { select: false });

    if (!cover) {
        return;
    }

    const field = fieldCatalog().find((item) => item.key === 'student_name') || fieldCatalog().find((item) => !item.custom) || fieldCatalog()[0];
    const fontSize = Math.max(14, Math.min(64, Math.round(height * 0.5)));

    if (field) {
        await addElement(buildElement('dynamic_text', {
            name: field.label,
            field: field.key,
            placeholder: field.label,
            textAlign: useSelection ? selected.textAlign : 'left',
            width,
            fontSize,
            ...position,
        }));
    } else {
        await addElement(buildElement('text', {
            name: 'Replacement Text',
            text: 'Replacement text',
            width,
            fontSize,
            ...position,
        }));
    }

    showAlert('Cover placed — edit the field on top to change what it shows.', 'info');
}

async function uploadAsset(file, kind) {
    const form = new FormData();

    form.append('image', file);
    form.append('kind', kind);

    const response = await fetch(config.assetUrl, {
        method: 'POST',
        body: form,
        headers: {
            'X-CSRF-TOKEN': csrfToken(),
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json',
        },
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(payload?.errors?.image?.[0] || payload?.message || 'The image could not be uploaded.');
    }

    return payload;
}

const ASSET_PRESETS = {
    photo: { name: 'Student Photo', fit: 'cover', frame: 'circle', ratio: 0.24 },
    logo: { name: 'School Logo', fit: 'contain', frame: 'none', ratio: 0.18 },
    student_signature: { name: 'Student Signature', fit: 'contain', frame: 'none', ratio: 0.26 },
    principal_signature: { name: 'Principal Signature', fit: 'contain', frame: 'none', ratio: 0.26 },
    custom: { name: 'Custom Image', fit: 'contain', frame: 'none', ratio: 0.25 },
};

async function addUploadedImage(file, kind) {
    const preset = ASSET_PRESETS[kind] || ASSET_PRESETS.custom;

    showAlert('Uploading image…', 'info', true);

    try {
        const asset = await uploadAsset(file, kind);
        const width = Math.round(currentCard().width * preset.ratio);
        const height = preset.frame === 'circle' ? width : Math.round(width * ((asset.height || 1) / (asset.width || 1)));

        await addElement(buildElement('image', {
            name: preset.name,
            src: asset.url,
            fit: preset.fit,
            frame: preset.frame,
            width,
            height,
        }));

        hideAlert();
    } catch (error) {
        showAlert(error.message || 'The image could not be uploaded.');
    }
}

async function replaceSelectedImage(file, kind) {
    const id = state.replaceTargetId;

    state.replaceTargetId = null;

    if (!id) {
        return;
    }

    showAlert('Uploading image…', 'info', true);

    try {
        const asset = await uploadAsset(file, kind);

        await updateElement(id, { src: asset.url });
        hideAlert();
    } catch (error) {
        showAlert(error.message || 'The image could not be uploaded.');
    }
}

/**
 * Decode a picked file into a real image.
 *
 * The promise only settles once the browser has finished decoding the bitmap,
 * and it is rejected for anything that is not a usable image or that decodes
 * without dimensions. Callers therefore never read width / height from a half
 * loaded, empty or damaged bitmap, which is what used to produce a 0 x 0 card
 * (and the "cannot read properties of undefined" crash) on a bad upload.
 */
function loadImageElement(file) {
    return new Promise((resolve, reject) => {
        if (!file) {
            reject(new Error('No file was selected.'));

            return;
        }

        if (file.type && !file.type.startsWith('image/')) {
            reject(new Error('Only JPG, JPEG and PNG images can be used as a card design.'));

            return;
        }

        const url = URL.createObjectURL(file);
        const image = new Image();

        image.onload = () => {
            URL.revokeObjectURL(url);

            if (!(image.naturalWidth > 0) || !(image.naturalHeight > 0)) {
                reject(new Error('That image is empty or damaged and cannot be used as a card design.'));

                return;
            }

            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('That file could not be read as an image.'));
        };
        image.src = url;
    });
}

async function handleDesignUpload(side, file) {
    const image = await loadImageElement(file);
    const scene = state.scenes[side];
    const other = state.scenes[side === 'front' ? 'back' : 'front'];
    const card = {
        width: image.naturalWidth,
        height: image.naturalHeight,
        orientation: image.naturalWidth >= image.naturalHeight ? 'landscape' : 'portrait',
    };

    if (scene.background?.src?.startsWith('blob:')) {
        URL.revokeObjectURL(scene.background.src);
    }

    scene.card = { ...card };
    other.card = { ...card };
    scene.background = { src: URL.createObjectURL(file), file, visible: true };

    // Keep the untouched bitmap around: every mask is cut out of this original,
    // never out of an already masked result.
    state.sources[side] = image;
    state.regions[side] = [];
    invalidateMaskedBackground(side);

    applyCardToInputs();
    updateDesignStates();
    markDirty();

    if (state.side === side) {
        try {
            await loadSide(side);
            await detectRegions({ silent: true });
        } catch (error) {
            console.error(`[id-card] ${side} design could not be rendered`, error);
            showAlert('The design image could not be displayed. Please upload it again.');
        }
    }
}

function updateDesignStates() {
    const describe = (side) => {
        const scene = state.scenes[side];

        if (scene.background?.file) {
            return `${scene.background.file.name} · uploaded on save`;
        }

        return scene.background?.src ? 'Design loaded' : 'Not uploaded';
    };

    elements.frontState.textContent = describe('front');
    elements.backState.textContent = describe('back');
    elements.cardHint.textContent = `Card size follows the uploaded image (${currentCard().width} × ${currentCard().height} px), so the design is never stretched.`;
}

/* -------------------------------------------------------------------------
 | Editable content regions
  ---------------------------------------------------------------------- */

const STAGE_HINT_DEFAULT = 'Drag to move · corner handles resize · top handle rotates · Delete removes the selection · Ctrl/Cmd + D duplicates.';

/**
 * Everything the region tools add to the canvas (guides plus the rubber band
 * rectangle). These objects are never stored and never saved.
 */
function regionObjects() {
    return canvas ? canvas.getObjects().filter((object) => {
        const role = object.idcard?.role;

        return role === 'region-guide' || role === 'region-draft';
    }) : [];
}

function guideCount() {
    return canvas ? canvas.getObjects().filter((object) => object.idcard?.role === 'region-guide').length : 0;
}

/**
 * The first canvas index a layer may occupy: above the background and above the
 * region guides.
 */
function guideBaseIndex() {
    return (backgroundObject() ? 1 : 0) + guideCount();
}

function clearRegionObjects() {
    if (!canvas) {
        return;
    }

    regionObjects().forEach((object) => canvas.remove(object));
}

/**
 * Repaint the dashed boxes over the content that is still flattened.
 */
function renderRegionGuides() {
    if (!canvas) {
        return;
    }

    clearRegionObjects();

    if (state.regionMode) {
        canvas.requestRenderAll();

        return;
    }

    const regions = state.showRegions ? state.regions[state.side] : [];
    const base = backgroundObject() ? 1 : 0;

    regions.forEach((region, index) => {
        canvas.insertAt(buildRegionGuide(region, state.zoom), base + index);
    });

    canvas.requestRenderAll();
}

/**
 * One line of plain English about what is currently editable on this side.
 */
function updateRegionState() {
    if (!elements.regionState) {
        return;
    }

    const scene = currentScene();
    const found = state.regions[state.side].length;
    const erased = (scene.masks || []).length;
    const hasDesign = Boolean(state.sources[state.side]);
    const parts = [];

    if (state.regionMode) {
        parts.push('Drag a box over the text you want to edit. Esc cancels.');
    } else if (!hasDesign) {
        parts.push('Upload the flat design to detect the text and images printed on it.');
    } else if (found) {
        parts.push(`${found} image region${found === 1 ? '' : 's'} found — click a dashed box to replace that photo, logo or barcode.`);
    } else if (scene.elements.length) {
        parts.push('The detected content is editable — pick a layer to retype, move, resize or delete it.');
    } else {
        parts.push('Nothing was detected automatically. Use “Add editable text” and drag a box over the content.');
    }

    if (erased) {
        parts.push(`${erased} area${erased === 1 ? '' : 's'} erased from the artwork.`);
    }

    elements.regionState.textContent = parts.join(' ');
}

/**
 * Remember one erased rectangle.
 *
 * `elementId` records which layer the hole was cut for, so deleting that layer
 * can put its own patch of artwork back. A mask with no owner is a mask the user
 * drew by hand and outlives every layer.
 */
function addMask(rect, elementId = null) {
    const scene = currentScene();

    if (scene.masks.length >= MAX_MASKS) {
        showAlert(`A card side can hold up to ${MAX_MASKS} erased areas.`);

        return null;
    }

    const mask = normalizeMask({
        id: uid('mk'),
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        elementId,
    });

    scene.masks.push(mask);
    markDirty();

    return mask;
}

/**
 * Forget one erased rectangle by id.
 */
function removeMask(id, side = state.side) {
    const scene = state.scenes[side];

    if (!scene) {
        return false;
    }

    const before = scene.masks.length;

    scene.masks = scene.masks.filter((mask) => mask.id !== id);

    if (scene.masks.length === before) {
        return false;
    }

    markDirty();

    return true;
}

/**
 * Forget every rectangle that was cut for one layer, and nothing else.
 */
function releaseMasksOf(elementId, side = state.side) {
    const scene = state.scenes[side];

    if (!scene || !elementId) {
        return false;
    }

    const before = scene.masks.length;

    scene.masks = scene.masks.filter((mask) => mask.elementId !== elementId);

    if (scene.masks.length === before) {
        return false;
    }

    markDirty();

    return true;
}

/**
 * Put the untouched design back while keeping every editable layer in place.
 */
async function restoreArtwork() {
    const scene = currentScene();

    if (!scene.masks.length) {
        showAlert('Nothing has been erased on this side yet.', 'info');

        return;
    }

    scene.masks = [];
    markDirty();
    await refreshBackground();
    renderRegionGuides();
    updateStageMeta();
    updateRegionState();
    showAlert('Original artwork restored. The editable layers are still on top of it.', 'info');
}

/**
 * Find the text and image blocks printed into the flat design of one side.
 *
 * Detection is only half the job: the rectangles are turned into real layers
 * right here, so one click on "Detect Content" leaves the user with an editable
 * layer for every piece of content on the card instead of a set of boxes to click
 * one by one.
 *
 * The detector reports one rectangle per line of content - see detect.js - so the
 * rectangles are used exactly as they come back: never merged, and only the ones
 * that do not have a layer yet are converted, which is what keeps a second click
 * on "Detect Content" from stacking a copy of every layer.
 *
 * The silent pass (on boot and after a design upload) only measures. It must
 * never mask anything, or merely opening a saved template would erase its
 * artwork and stack a second copy of every layer on top of the first.
 */
async function detectRegions({ silent = false } = {}) {
    const side = state.side;
    const source = state.sources[side];

    if (!source) {
        if (!silent) {
            showAlert('Upload the design image for this side first.');
        }

        updateRegionState();

        return [];
    }

    if (!silent) {
        showAlert('Looking for text and images in the design…', 'info', true);
        await new Promise((resolve) => window.setTimeout(resolve, 16));
    }

    const found = pendingRegions(
        dropDuplicateRegions(detectDesignRegions(source, currentCard())),
        state.scenes[side],
    ).sort((a, b) => (a.top - b.top) || (a.left - b.left));

    state.regions[side] = found;
    renderRegionGuides();
    updateRegionState();

    if (silent) {
        return found;
    }

    // Each text region becomes its own layer; the image-like ones stay as dashed
    // guides because a photo or a barcode can only be replaced with a file.
    const { graphic } = partitionRegions(found);
    const created = await convertDetectedRegions(found, side);

    renderRegionGuides();
    updateRegionState();

    if (created.length) {
        const layers = `${created.length} editable text layer${created.length === 1 ? '' : 's'} added to the Layers panel — the flattened original has been erased underneath, so type the new text on each layer.`;

        showAlert(
            graphic.length
                ? `${layers} ${graphic.length} image region${graphic.length === 1 ? '' : 's'} left as dashed boxes: click one to replace a photo, logo or barcode.`
                : layers,
            'info',
        );
    } else if (found.length) {
        showAlert('Nothing new could be turned into a layer. Use “Add Editable Text” and drag a box over the content.');
    } else {
        showAlert(
            currentScene().elements.length
                ? 'No further content found — everything detected on this side is already an editable layer. Use “Restore Original Artwork” and then “Detect Content” to scan the design again.'
                : 'No content could be detected automatically. Use “Add editable text” and drag a box over it.',
            currentScene().elements.length ? 'info' : 'error',
        );
    }

    return found;
}

/**
 * Two detected rectangles describe the same piece of content.
 *
 * A guide holds a *copy* of the region it was drawn from (see buildRegionGuide),
 * so the region has to be matched by its geometry - comparing object identity
 * would never match and the guide would stay on the canvas after the content it
 * belongs to has already been converted into a layer.
 */
function sameRegion(a, b) {
    return a
        && b
        && a.left === b.left
        && a.top === b.top
        && a.width === b.width
        && a.height === b.height;
}

/**
 * Stop offering a region, so it cannot be converted into a second layer or a
 * second mask over the same flattened pixels.
 */
function forgetRegion(side, region) {
    const regions = state.regions[side];

    if (!Array.isArray(regions)) {
        return;
    }

    const index = regions.findIndex((candidate) => candidate === region || sameRegion(candidate, region));

    if (index >= 0) {
        regions.splice(index, 1);
    }
}

/**
 * Erase a region of flattened artwork and drop a real layer into the hole.
 *
 * A photo, logo, barcode or signature is a picture, not something the builder can
 * invent: the replacement is chosen by the user, so ask for the file first and
 * only erase once we really have something to put there. The region stays listed
 * until the upload succeeds, so cancelling the picker leaves the guide on screen
 * instead of losing the content.
 */
async function convertRegion(region) {
    const side = state.side;

    if (region.kind === 'graphic') {
        state.pendingAssetRect = { ...region, side };
        renderRegionGuides();
        elements.fileAsset.click();

        return [];
    }

    // Every other origin - a clicked dashed box, a box dragged by hand, or the
    // whole batch of a detection run - ends up in the same place: one mask and
    // one independent layer per region.
    return convertDetectedRegions([region], side);
}

/**
 * Turn detected text regions into independent editable layers.
 *
 * This is the step that makes detection useful. A red box on its own changes
 * nothing; what the user needs is a layer they can select, retype, drag, resize
 * and delete without touching any of the other content. So every region gets:
 *
 *   1. its own mask, cut from the pristine bitmap, so the flattened original can
 *      never show through the replacement that sits on top of it,
 *   2. its own layer, positioned and sized on that exact rectangle, with the ink
 *      colour sampled from the original so the replacement blends in,
 *   3. its own name in the Layers panel.
 *
 * Regions are never merged: a card whose name, designation, ID, email and phone
 * are five separate lines ends up with five separate layers.
 *
 * The masks are collected first and the background is re-rendered once for the
 * whole batch, because re-inpainting the bitmap per region is what made a card
 * with a dozen regions feel like it had hung.
 *
 * @param {Array<object>} regions regions to convert
 * @param {string} side the side they were detected on
 * @returns {Promise<Array<string>>} the ids of the layers that were created
 */
async function convertDetectedRegions(regions, side = state.side) {
    const { text } = partitionRegions(regions);

    if (!text.length) {
        return [];
    }

    const scene = state.scenes[side];
    const source = state.sources[side];
    let ordinal = scene.elements.filter((element) => element.type === 'text').length;
    const created = [];

    // A region that has a layer must not be offered again: no second guide over
    // the same pixels and no second mask stacked on the first one.
    text.forEach((region) => forgetRegion(side, region));
    renderRegionGuides();

    for (const region of text) {
        // The user may have switched sides while the layers were being built.
        if (state.side !== side) {
            break;
        }

        if (scene.elements.length >= MAX_ELEMENTS) {
            showAlert(`A card side can hold up to ${MAX_ELEMENTS} layers.`);

            break;
        }

        if (scene.masks.length >= MAX_MASKS) {
            showAlert(`A card side can hold up to ${MAX_MASKS} erased areas.`);

            break;
        }

        ordinal += 1;

        const element = buildElement('text', {
            name: `Editable text ${ordinal}`,
            text: '',
            left: region.left,
            top: region.top,
            width: Math.max(region.width, 24),
            height: Math.max(region.height, 12),
            fontSize: region.fontSize || Math.max(10, Math.round(region.height / 1.6)),
            fill: (source ? sampleRegionColours(source, scene.card, region) : {}).fill || '#111111',
        });

        // The mask goes first so the layer is never left sitting on artwork it
        // was supposed to hide, and both halves are created or neither is.
        const mask = addMask(region, element.id);

        if (!mask) {
            break;
        }

        const object = await addElement(element, { select: false });

        if (!object) {
            removeMask(mask.id, side);

            continue;
        }

        created.push(element.id);
    }

    if (created.length) {
        // One re-render for the whole batch instead of one per region. A masking
        // failure must not undo the layers that were built: they are already in
        // the store, so the user keeps working and the artwork is simply shown
        // unedited until the next refresh.
        try {
            await refreshBackground(side);
        } catch (error) {
            console.error('[id-card] artwork could not be masked', error);
        }

        renderRegionGuides();
        updateStageMeta(scene);

        // Hand the user the first layer so the handles are right there, but only
        // while the side they were created on is still the one on the canvas.
        if (state.side === side) {
            selectObject(objectFor(created[0]));
        }
    }

    updateRegionState();

    return created;
}

/**
 * Ask for a replacement picture for a detected photo / logo / barcode and mask
 * the flattened original once the upload succeeds.
 */
async function addReplacementImage(file) {
    const rect = state.pendingAssetRect;

    state.pendingAssetRect = null;

    // Cancelling the file picker leaves the guide on the card, so the detected
    // photo / logo can be tried again instead of disappearing for good.
    if (!file || !rect) {
        return;
    }

    let asset = null;

    try {
        asset = await uploadAsset(file);
    } catch (error) {
        showAlert(error.message || 'The image could not be uploaded. The original is still in place.');
        renderRegionGuides();

        return;
    }

    if (!asset?.url) {
        showAlert('The image could not be uploaded. The original is still in place.');
        renderRegionGuides();

        return;
    }

    const width = Math.max(Number(rect.width) || 16, 16);
    const height = Math.max(Number(rect.height) || 16, 16);

    // Uploading takes a moment and the user can switch sides meanwhile. Erasing
    // is destructive, so go back to the side the region was found on rather than
    // masking the artwork of the card the user is now looking at.
    if (rect.side && rect.side !== state.side) {
        await switchSide(rect.side);
    }

    forgetRegion(state.side, rect);

    const image = buildElement('image', {
        // The detector can tell a photo from a barcode without reading it, so the
        // replacement is listed under the piece of content it replaces.
        name: rect.label || 'Replaced image',
        src: asset.url,
        fit: 'cover',
        frame: 'none',
        left: rect.left,
        top: rect.top,
        width,
        height,
    });

    // Mask the flattened original under the replacement, and tie the hole to the
    // layer so deleting that layer brings the original photo back with it.
    const mask = addMask(rect, image.id);

    if (!await addElement(image)) {
        removeMask(mask?.id);
        renderRegionGuides();

        return;
    }

    renderRegionGuides();
    await refreshBackground();
    updateRegionState();
}

/**
 * Manual alternative to detection: drag a box and make it editable.
 */
function setRegionMode(on) {
    const wanted = Boolean(on);

    if (wanted && !state.sources[state.side]) {
        showAlert('Upload the design image for this side first.');

        return;
    }

    state.regionMode = wanted;
    regionOrigin = null;
    clearRegionDraft();

    if (canvas) {
        canvas.skipTargetFind = state.regionMode;
        canvas.defaultCursor = state.regionMode ? 'crosshair' : 'default';
    }

    qsa('[data-action="add-editable-text"]').forEach((button) => {
        button.classList.toggle('is-active', state.regionMode);
    });

    if (elements.stageHint) {
        elements.stageHint.textContent = state.regionMode
            ? 'Drag a box over the text or image you want to edit. Esc cancels.'
            : STAGE_HINT_DEFAULT;
    }

    renderRegionGuides();
    updateRegionState();
}

function startRegionDraw(event) {
    const pointer = canvas.getPointer(event.e);

    regionOrigin = { left: pointer.x, top: pointer.y };
    regionDraft = buildRegionDraft({ left: pointer.x, top: pointer.y, width: 1, height: 1 }, state.zoom);
    canvas.add(regionDraft);
}

function updateRegionDraw(event) {
    if (!state.regionMode || !regionOrigin || !regionDraft) {
        return;
    }

    const pointer = canvas.getPointer(event.e);

    regionDraft.set({
        left: Math.min(regionOrigin.left, pointer.x),
        top: Math.min(regionOrigin.top, pointer.y),
        width: Math.abs(pointer.x - regionOrigin.left),
        height: Math.abs(pointer.y - regionOrigin.top),
    });
    regionDraft.setCoords();
    canvas.requestRenderAll();
}

async function finishRegionDraw() {
    if (!state.regionMode || !regionOrigin || !regionDraft) {
        return;
    }

    const rect = {
        left: regionDraft.left,
        top: regionDraft.top,
        width: regionDraft.width,
        height: regionDraft.height,
    };

    clearRegionDraft();
    regionOrigin = null;
    setRegionMode(false);

    if (rect.width < 8 || rect.height < 6) {
        showAlert('Drag a slightly bigger box over the content you want to edit.');

        return;
    }

    await convertRegion({
        ...rect,
        kind: 'text',
        fontSize: Math.max(10, Math.round(rect.height / 1.6)),
    });
}

function clearRegionDraft() {
    if (regionDraft && canvas) {
        canvas.remove(regionDraft);
    }

    regionDraft = null;
}

function toggleRegionGuides() {
    state.showRegions = !state.showRegions;
    renderRegionGuides();
    updateRegionState();
}

/* -------------------------------------------------------------------------
 | Selection + canvas events
 ---------------------------------------------------------------------- */

function selectObject(object) {
    if (!canvas) {
        return;
    }

    canvas.discardActiveObject();

    if (object) {
        if (object.canvas !== canvas) {
            canvas.add(object);
        }
        canvas.setActiveObject(object);
        object.setCoords?.();
        state.selectedId = object.idcard?.id || null;
    } else {
        state.selectedId = null;
    }

    canvas.requestRenderAll();
    renderProperties();
    renderLayers();
}

/**
 * A dashed region guide is an editing affordance, not a layer: clicking it turns
 * that flattened rectangle into a real editable element.
 *
 * Fabric reports the object that was clicked in `event.selected`, not on
 * `event.target`, and it only raises `selection:created` when nothing else was
 * selected first. Clicking a guide while a text layer is active arrives as
 * `selection:updated`, so both events have to be handled or the replacement
 * picker silently never opens.
 *
 * @returns {boolean} true when the click belonged to a guide and was consumed.
 */
function consumeRegionGuideSelection(event) {
    const object = event?.selected?.[0] || event?.target;

    if (object?.idcard?.role !== 'region-guide') {
        return false;
    }

    const region = object.idcard.region;

    // Clear our own id first: discarding the active object fires
    // `selection:cleared`, which would otherwise fall back to the stale id and
    // leave the Layers panel highlighting a layer that is not on the canvas.
    state.selectedId = null;
    canvas.discardActiveObject();
    window.setTimeout(() => convertRegion(region), 0);

    return true;
}

function bindCanvasEvents() {
    canvas.on('selection:created', (event) => {
        if (consumeRegionGuideSelection(event)) {
            return;
        }

        onSelectionChanged();
    });
    canvas.on('selection:updated', (event) => {
        if (consumeRegionGuideSelection(event)) {
            return;
        }

        onSelectionChanged();
    });
    canvas.on('selection:cleared', () => onSelectionChanged());

    canvas.on('object:moving', () => updateStageMeta());
    canvas.on('object:scaling', () => updateStageMeta());
    canvas.on('object:rotating', () => updateStageMeta());

    canvas.on('object:modified', async (event) => {
        const object = event.target;

        if (!object?.idcard?.id || object.idcard.role === 'background') {
            return;
        }

        const element = findElement(object.idcard.id);

        if (!element) {
            return;
        }

        const needsRebuild = syncGeometry(object, element);

        markDirty();
        updateStageMeta();

        if (needsRebuild) {
            await replaceElementObject(canvas, object, element, { interactive: true, fields: fieldCatalog() });
        }

        renderProperties();
        renderLayers();
    });

    canvas.on('text:changed', (event) => {
        const element = findElement(event.target?.idcard?.id);

        if (element) {
            element.text = event.target.text;
            markDirty();
        }
    });

    canvas.on('text:editing:exited', (event) => {
        const element = findElement(event.target?.idcard?.id);

        if (element) {
            element.text = event.target.text;
            element.height = round(event.target.height, 2);
            markDirty();
            renderLayers();
        }
    });

    canvas.on('mouse:down', (event) => {
        if (state.regionMode) {
            startRegionDraw(event);

            return;
        }

        if (!event.target) {
            selectObject(null);
        }
    });

    canvas.on('mouse:move', (event) => {
        if (state.regionMode) {
            updateRegionDraw(event);
        }
    });

    canvas.on('mouse:up', () => {
        if (state.regionMode) {
            finishRegionDraw();
        }
    });
}

function onSelectionChanged() {
    const object = selectedObject();

    state.selectedId = object?.idcard?.id || null;
    renderProperties();
    renderLayers();
}

/* -------------------------------------------------------------------------
 | Element operations
 ---------------------------------------------------------------------- */

async function updateElement(id, changes, { rebuild = true } = {}) {
    const element = findElement(id);

    if (!element) {
        return;
    }

    Object.assign(element, changes);
    markDirty();

    let object = objectFor(id);

    if (object && rebuild) {
        object = await replaceElementObject(canvas, object, element, { interactive: true, fields: fieldCatalog() });
        canvas.requestRenderAll();

        if (object && TEXT_TYPES.includes(element.type)) {
            element.height = round(object.height || element.height, 2);
        }
    }

    renderProperties();
    renderLayers();
    updateStageMeta();
}

function duplicateSelected() {
    const element = selectedElement();

    if (!element) {
        showAlert('Select a layer first.');

        return;
    }

    if (currentScene().elements.length >= MAX_ELEMENTS) {
        showAlert(`A card side can hold up to ${MAX_ELEMENTS} layers.`);

        return;
    }

    const copy = JSON.parse(JSON.stringify(element));

    copy.id = uid();
    copy.name = `${element.name} copy`;
    copy.left = round(element.left + 16, 2);
    copy.top = round(element.top + 16, 2);
    copy.locked = false;

    addElement(copy);
}

/**
 * Remove the selected layer - and only that layer.
 *
 * The artwork under a converted layer was masked for that layer alone, so the
 * mask is released with it: the original pixels come back where the deleted
 * layer used to be, and every other layer, mask and element on the side is left
 * exactly as it was. Masks with no owner were cut by hand (Cover / Erase Area)
 * and are always kept.
 */
function deleteSelected() {
    const element = selectedElement();

    if (!element) {
        return;
    }

    const object = objectFor(element.id);

    if (object) {
        canvas.remove(object);
    }

    currentScene().elements = currentScene().elements.filter((item) => item.id !== element.id);

    if (releaseMasksOf(element.id)) {
        invalidateMaskedBackground(state.side);
        scheduleBackgroundRefresh(state.side);
    }

    selectObject(null);
    markDirty();
    canvas.requestRenderAll();
    renderLayers();
    updateStageMeta();
    updateRegionState();
}

function toggleVisibility(id = state.selectedId) {
    const element = findElement(id);

    if (!element) {
        return;
    }

    element.visible = !element.visible;

    const object = objectFor(id);

    if (object) {
        object.visible = element.visible;
        const interactive = element.visible && !element.locked;
        object.selectable = interactive;
        object.evented = interactive;
        object.hasControls = interactive;
        object.hasBorders = interactive;
        object.lockMovementX = element.locked;
        object.lockMovementY = element.locked;
        object.lockScalingX = element.locked;
        object.lockScalingY = element.locked;
        object.lockRotation = element.locked;
        object.hoverCursor = element.locked ? 'not-allowed' : 'move';
        object.setCoords?.();
    }

    if (!element.visible && state.selectedId === id) {
        state.selectedId = null;
        canvas.discardActiveObject();
    }

    markDirty();
    canvas.requestRenderAll();
    renderProperties();
    renderLayers();
}

async function toggleLock(id = state.selectedId) {
    const element = findElement(id);

    if (!element) {
        return;
    }

    await updateElement(id, { locked: !element.locked });
}

function moveLayer(direction) {
    const object = selectedObject();

    if (!object) {
        return;
    }

    const objects = canvas.getObjects();
    const index = objects.indexOf(object);
    // guideBaseIndex() already accounts for the guides, so it *is* the lowest
    // index a real layer may occupy. Adding the guide count again would push
    // "send to back" below the guides and desync the stored layer order.
    const lowest = guideBaseIndex();
    let target = index;

    if (direction === 'front') {
        target = objects.length - 1;
    } else if (direction === 'back') {
        target = lowest;
    } else if (direction === 'up') {
        target = Math.min(objects.length - 1, index + 1);
    } else if (direction === 'down') {
        target = Math.max(lowest, index - 1);
    }

    if (target !== index) {
        canvas.moveTo(object, target);
        moveStoredLayer(object.idcard.id, target - lowest);
        canvas.requestRenderAll();
        markDirty();
        renderLayers();
    }
}

/**
 * Re-order the stored scene so the layers panel, the saved JSON and the canvas
 * stack always describe the same order.
 */
function moveStoredLayer(id, index) {
    const elements = currentScene().elements;
    const from = elements.findIndex((element) => element.id === id);

    if (from < 0) {
        return;
    }

    const [element] = elements.splice(from, 1);

    elements.splice(clamp(index, 0, elements.length), 0, element);
}

function nudgeSelected(dx, dy) {
    const object = selectedObject();
    const element = selectedElement();

    if (!object || !element || element.locked) {
        return;
    }

    object.set({ left: round(object.left + dx, 2), top: round(object.top + dy, 2) });
    object.setCoords?.();
    canvas.requestRenderAll();

    syncGeometry(object, findElement(object.idcard.id));
    markDirty();

    ['left', 'top'].forEach((prop) => {
        const input = elements.propertiesPanel.querySelector(`[data-prop="${prop}"]`);

        if (input) {
            input.value = prop === 'left' ? object.left : object.top;
        }
    });
}

/* -------------------------------------------------------------------------
 | Properties panel
 ---------------------------------------------------------------------- */

function numberInput(prop, label, value, options = {}) {
    return `
        <label class="idc-prop">
            <span>${escapeHtml(label)}</span>
            <input type="number" data-prop="${prop}" value="${escapeHtml(round(value, 2))}"
                   step="${options.step ?? 1}" min="${options.min ?? ''}" max="${options.max ?? ''}">
        </label>`;
}

function colorInput(prop, label, value) {
    return `
        <label class="idc-prop">
            <span>${escapeHtml(label)}</span>
            <input type="color" data-prop="${prop}" value="${hexColor(value)}">
        </label>`;
}

function selectInput(prop, label, value, options) {
    const items = options
        .map((option) => {
            const optionValue = typeof option === 'string' ? option : option.value;
            const optionLabel = typeof option === 'string' ? option : option.label;

            return `<option value="${escapeHtml(optionValue)}"${optionValue === value ? ' selected' : ''}>${escapeHtml(optionLabel)}</option>`;
        })
        .join('');

    return `
        <label class="idc-prop">
            <span>${escapeHtml(label)}</span>
            <select data-prop="${prop}">${items}</select>
        </label>`;
}

function checkboxInput(prop, label, value) {
    return `
        <label class="idc-prop idc-prop--check">
            <input type="checkbox" data-prop="${prop}"${value ? ' checked' : ''}>
            <span>${escapeHtml(label)}</span>
        </label>`;
}

function textAreaInput(prop, label, value, rows = 3) {
    return `
        <label class="idc-prop idc-prop--wide">
            <span>${escapeHtml(label)}</span>
            <textarea data-prop="${prop}" rows="${rows}">${escapeHtml(value)}</textarea>
        </label>`;
}

function textInput(prop, label, value, extra = '') {
    return `
        <label class="idc-prop${extra}">
            <span>${escapeHtml(label)}</span>
            <input type="text" data-prop="${prop}" maxlength="120" value="${escapeHtml(value)}">
        </label>`;
}

function fieldOptions() {
    return [
        { value: '', label: '— none —' },
        ...fieldCatalog().map((field) => ({ value: field.key, label: `${field.label} (${field.key})` })),
    ];
}

function geometryHtml(element) {
    return `
        <div class="idc-props__grid">
            ${numberInput('left', 'X', element.left)}
            ${numberInput('top', 'Y', element.top)}
            ${numberInput('width', 'Width', element.width, { min: 4 })}
            ${element.type === 'line' ? '' : numberInput('height', 'Height', element.height, { min: 4 })}
            ${numberInput('angle', 'Rotation', element.angle)}
            ${numberInput('opacity', 'Opacity', element.opacity, { step: 0.05, min: 0, max: 1 })}
        </div>`;
}

function propertiesHtml(element) {
    const blocks = [`
        <div class="idc-props__row">
            ${textInput('name', 'Layer name', element.name, ' idc-prop--wide')}
        </div>`];

    if (TEXT_TYPES.includes(element.type)) {
        if (element.type === 'dynamic_text') {
            blocks.push(`
                <div class="idc-props__grid">
                    ${selectInput('field', 'Field', element.field, fieldOptions())}
                    ${textInput('placeholder', 'Placeholder', element.placeholder || '')}
                </div>`);
        } else {
            blocks.push(textAreaInput(
                'text',
                element.type === 'terms' ? 'Terms & conditions text' : 'Text',
                element.text,
                element.type === 'terms' ? 7 : 3,
            ));
        }

        blocks.push(`
            <div class="idc-props__grid">
                ${selectInput('fontFamily', 'Font', element.fontFamily, (config.fontFamilies || ['Arial']).map((font) => ({ value: font, label: font })))}
                ${numberInput('fontSize', 'Font size', element.fontSize, { min: 4, max: 400 })}
                ${selectInput('fontWeight', 'Weight', element.fontWeight, [{ value: 'normal', label: 'Normal' }, { value: 'bold', label: 'Bold' }])}
                ${selectInput('textAlign', 'Align', element.textAlign, [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }, { value: 'justify', label: 'Justify' }])}
                ${colorInput('fill', 'Colour', element.fill)}
                ${numberInput('lineHeight', 'Line height', element.lineHeight, { step: 0.05, min: 0.5, max: 5 })}
                ${numberInput('letterSpacing', 'Letter spacing', element.letterSpacing, { step: 0.5, min: -20, max: 60 })}
                ${selectInput('textTransform', 'Transform', element.textTransform, TRANSFORMS.map((value) => ({ value, label: value })))}
            </div>
            <div class="idc-props__checks">
                ${checkboxInput('italic', 'Italic', element.italic)}
                ${checkboxInput('underline', 'Underline', element.underline)}
            </div>`);
    }

    if (element.type === 'qrcode' || element.type === 'barcode') {
        blocks.push(`
            <div class="idc-props__grid">
                ${selectInput('dataSource', 'Data source', element.dataSource, [{ value: 'field', label: 'Dynamic field' }, { value: 'custom', label: 'Custom value' }])}
                ${selectInput('dataField', 'Field', element.dataField, fieldOptions())}
                <label class="idc-prop">
                    <span>Custom value</span>
                    <input type="text" data-prop="dataValue" maxlength="500" value="${escapeHtml(element.dataValue || '')}">
                </label>
                ${element.type === 'qrcode'
                    ? selectInput('qrEcc', 'Error correction', element.qrEcc, ['L', 'M', 'Q', 'H'].map((value) => ({ value, label: value })))
                    : selectInput('barcodeFormat', 'Format', element.barcodeFormat, BARCODE_FORMATS.map((value) => ({ value, label: value })))}
            </div>`);
    }

    if (element.type === 'image') {
        blocks.push(`
            <div class="idc-props__grid">
                ${selectInput('fit', 'Object fit', element.fit, FITS.map((value) => ({ value, label: value })))}
                ${selectInput('frame', 'Frame', element.frame, FRAMES.map((value) => ({ value, label: value })))}
                ${numberInput('radius', 'Corner radius', element.radius, { min: 0 })}
                ${numberInput('strokeWidth', 'Border width', element.strokeWidth, { min: 0, max: 40 })}
                ${colorInput('stroke', 'Border colour', element.stroke)}
            </div>
            <div class="idc-props__row">
                <button type="button" class="idc-btn idc-btn--sm" data-action="replace-asset">Replace image…</button>
            </div>`);
    }

    if (element.type === 'cover' || element.type === 'rect') {
        blocks.push(`
            <div class="idc-props__grid">
                ${colorInput('bg', 'Background', element.bg)}
                ${numberInput('radius', 'Corner radius', element.radius, { min: 0 })}
                ${numberInput('strokeWidth', 'Border width', element.strokeWidth, { min: 0, max: 40 })}
                ${colorInput('stroke', 'Border colour', element.stroke)}
            </div>`);
    }

    if (element.type === 'circle') {
        blocks.push(`
            <div class="idc-props__grid">
                ${colorInput('bg', 'Fill', element.bg)}
                ${numberInput('strokeWidth', 'Border width', element.strokeWidth, { min: 0, max: 40 })}
                ${colorInput('stroke', 'Border colour', element.stroke)}
            </div>`);
    }

    if (element.type === 'line') {
        blocks.push(`
            <div class="idc-props__grid">
                ${colorInput('bg', 'Colour', element.bg)}
                ${numberInput('strokeWidth', 'Thickness', element.strokeWidth, { min: 1, max: 40 })}
            </div>`);
    }

    return `
        <div class="idc-props__head">
            <span class="idc-props__type">${escapeHtml(ELEMENT_LABELS[element.type] || element.type)}</span>
            <span class="idc-props__id">${escapeHtml(element.id)}</span>
        </div>
        ${blocks.join('')}
        ${geometryHtml(element)}
        <div class="idc-props__actions">
            <button type="button" class="idc-btn idc-btn--sm" data-action="duplicate">${icon('copy')} Duplicate</button>
            <button type="button" class="idc-btn idc-btn--sm" data-action="toggle-visibility">${element.visible ? 'Hide' : 'Show'}</button>
            <button type="button" class="idc-btn idc-btn--sm" data-action="toggle-lock">${element.locked ? 'Unlock' : 'Lock'}</button>
            <button type="button" class="idc-btn idc-btn--sm" data-action="delete">${icon('trash')} Delete</button>
        </div>`;
}

function renderProperties() {
    const element = selectedElement();
    const panel = elements.propertiesPanel;

    if (!element) {
        panel.innerHTML = '<p class="idc-empty">Select a layer to edit its position, size and style.</p>';

        return;
    }

    const focus = document.activeElement;
    const restore = focus && panel.contains(focus) && focus.dataset.prop
        ? { prop: focus.dataset.prop, start: focus.selectionStart, end: focus.selectionEnd }
        : null;

    panel.innerHTML = propertiesHtml(element);

    if (restore) {
        const field = panel.querySelector(`[data-prop="${restore.prop}"]`);

        if (field) {
            field.focus();

            if (restore.start !== null && restore.start !== undefined && typeof field.setSelectionRange === 'function') {
                try {
                    field.setSelectionRange(restore.start, restore.end);
                } catch (error) {
                    // number inputs do not support text selection ranges
                }
            }
        }
    }
}

async function onPropertyInput(event) {
    const input = event.target.closest('[data-prop]');

    if (!input) {
        return;
    }

    const element = selectedElement();

    if (!element) {
        return;
    }

    const prop = input.dataset.prop;
    const changes = {};

    if (input.type === 'checkbox') {
        changes[prop] = input.checked;
    } else if (input.type === 'number') {
        const parsed = parseFloat(input.value);

        if (Number.isNaN(parsed)) {
            return;
        }

        changes[prop] = parsed;
    } else {
        changes[prop] = input.value;
    }

    if (prop === 'field' || prop === 'dataField') {
        const field = fieldCatalog().find((item) => item.key === changes[prop]);

        if (prop === 'field' && field) {
            if (!element.placeholder) {
                changes.placeholder = field.label;
            }

            changes.name = field.label;
        }
    }

    await updateElement(element.id, changes);
}

function onPropertyClick(event) {
    const button = event.target.closest('[data-action]');

    if (!button) {
        return;
    }

    event.stopPropagation();

    switch (button.dataset.action) {
        case 'duplicate':
            duplicateSelected();
            break;
        case 'delete':
            deleteSelected();
            break;
        case 'toggle-visibility':
            toggleVisibility();
            break;
        case 'toggle-lock':
            toggleLock();
            break;
        case 'replace-asset':
            state.replaceTargetId = state.selectedId;
            state.pendingAssetKind = 'custom';
            elements.fileAsset.click();
            break;
        default:
            break;
    }
}

/* -------------------------------------------------------------------------
 | Layers panel
 ---------------------------------------------------------------------- */

function layerIcon(glyph, element) {
    if (glyph === 'visibility') {
        return element.visible ? icon('eye') : icon('eyeOff');
    }

    if (glyph === 'lock') {
        return element.locked ? icon('lock') : icon('unlock');
    }

    return icon(glyph);
}

function layerRow(element) {
    const tools = [
        ['layer-front', 'front', 'Bring to front'],
        ['layer-up', 'up', 'Move up'],
        ['layer-down', 'down', 'Move down'],
        ['layer-back', 'back', 'Send to back'],
        ['layer-visibility', 'visibility', element.visible ? 'Hide layer' : 'Show layer'],
        ['layer-lock', 'lock', element.locked ? 'Unlock layer' : 'Lock layer'],
        ['layer-duplicate', 'duplicate', 'Duplicate layer'],
        ['layer-delete', 'delete', 'Delete layer'],
    ];

    return `
        <li class="idc-layer${element.id === state.selectedId ? ' is-selected' : ''}${element.visible ? '' : ' is-hidden'}${element.locked ? ' is-locked' : ''}">
            <button type="button" class="idc-layer__name" data-action="select-layer" data-id="${escapeHtml(element.id)}">
                <span class="idc-layer__label">${escapeHtml(element.name)}</span>
                <span class="idc-layer__type">${escapeHtml(ELEMENT_LABELS[element.type] || element.type)}</span>
            </button>
            <span class="idc-layer__tools">
                ${tools.map(([action, glyph, title]) => `<button type="button" class="idc-iconbtn" data-action="${action}" data-id="${escapeHtml(element.id)}" title="${escapeHtml(title)}">${layerIcon(glyph, element)}</button>`).join('')}
            </span>
        </li>`;
}

function backgroundRow() {
    const scene = currentScene();
    const visible = scene.background.visible;

    return `
        <li class="idc-layer idc-layer--background${visible ? '' : ' is-hidden'}">
            <span class="idc-layer__name">
                <span class="idc-layer__label">Background (original design)</span>
                <span class="idc-layer__type">base image</span>
            </span>
            <span class="idc-layer__tools">
                <button type="button" class="idc-iconbtn" data-action="toggle-background" title="${visible ? 'Hide the design image' : 'Show the design image'}">${visible ? icon('eye') : icon('eyeOff')}</button>
                <span class="idc-iconbtn is-static" title="The original design image is always locked">${icon('lock')}</span>
            </span>
        </li>`;
}

function renderLayers() {
    const scene = currentScene();
    const rows = scene.elements.slice().reverse().map(layerRow);

    if (backgroundObject() || scene.background.src) {
        rows.push(backgroundRow());
    }

    elements.layersPanel.innerHTML = `<ul class="idc-layers">${rows.join('')}</ul>`;
}

function onLayersClick(event) {
    const button = event.target.closest('[data-action]');

    if (!button) {
        return;
    }

    const { action, id } = button.dataset;

    if (action === 'toggle-background') {
        const background = backgroundObject();

        state.scenes[state.side].background.visible = !state.scenes[state.side].background.visible;

        if (background) {
            background.visible = state.scenes[state.side].background.visible;
        }

        canvas.requestRenderAll();
        markDirty();
        renderLayers();

        return;
    }

    const element = findElement(id);

    if (!element) {
        return;
    }

    if (action === 'select-layer') {
        selectObject(objectFor(id));

        return;
    }

    if (action === 'layer-visibility') {
        toggleVisibility(id);

        return;
    }

    selectObject(objectFor(id));

    switch (action) {
        case 'layer-front':
            moveLayer('front');
            break;
        case 'layer-back':
            moveLayer('back');
            break;
        case 'layer-up':
            moveLayer('up');
            break;
        case 'layer-down':
            moveLayer('down');
            break;
        case 'layer-lock':
            toggleLock(id);
            break;
        case 'layer-duplicate':
            duplicateSelected();
            break;
        case 'layer-delete':
            deleteSelected();
            break;
        default:
            break;
    }
}

/* -------------------------------------------------------------------------
 | Custom fields
 ---------------------------------------------------------------------- */

function renderCustomFieldChips() {
    const custom = currentScene().custom_fields || [];

    if (!custom.length) {
        elements.customFields.innerHTML = '<span class="idc-muted">No custom fields yet.</span>';

        return;
    }

    elements.customFields.innerHTML = custom
        .map((field) => `<button type="button" class="idc-chip" data-action="add-dynamic" data-key="${escapeHtml(field.key)}" data-label="${escapeHtml(field.label)}">${escapeHtml(field.label)}</button>`)
        .join('');
}

/* -------------------------------------------------------------------------
 | Alerts
 ---------------------------------------------------------------------- */

function showAlert(message, tone = 'error', sticky = false) {
    elements.alert.textContent = message;
    elements.alert.hidden = false;
    elements.alert.dataset.tone = tone;

    window.clearTimeout(alertTimer);

    if (!sticky) {
        alertTimer = window.setTimeout(hideAlert, 6000);
    }
}

function hideAlert() {
    elements.alert.hidden = true;
}

/* -------------------------------------------------------------------------
 | Preview + save
 ---------------------------------------------------------------------- */

/**
 * Freeze the current canvas geometry into a portable scene description.
 */
function sceneForSerialization(side) {
    const scene = state.scenes[side];

    if (state.side === side) {
        canvas.getObjects().forEach((object) => {
            if (!object.idcard?.id || object.idcard.role === 'background') {
                return;
            }

            const element = scene.elements.find((item) => item.id === object.idcard.id);

            if (element) {
                syncGeometry(object, element);
            }
        });

        scene.background.visible = backgroundObject() ? backgroundObject().visible !== false : scene.background.visible;
    }

    return {
        version: 1,
        card: { ...scene.card },
        background: { visible: scene.background.visible, locked: true },
        custom_fields: (scene.custom_fields || []).map((field) => ({ ...field })),
        elements: scene.elements.map((element) => JSON.parse(JSON.stringify(element))),
        masks: (scene.masks || []).map((mask) => ({ ...mask })),
    };
}

async function openPreview() {
    elements.previewDialog.showModal();

    await Promise.all([
        renderSceneInto(elements.previewFront, sceneForSerialization('front'), {
            maxWidth: 560,
            maxHeight: 520,
            fields: fieldCatalog(),
            label: 'Front of the ID card',
        }),
        renderSceneInto(elements.previewBack, sceneForSerialization('back'), {
            maxWidth: 560,
            maxHeight: 520,
            fields: fieldCatalog(),
            label: 'Back of the ID card',
        }),
    ]);
}

function openSaveDialog() {
    elements.saveName.value = state.name;
    elements.saveStatus.value = state.status;
    elements.saveTitle.textContent = config.edit ? 'Update template' : 'Save template';
    renderSaveErrors({});
    elements.saveDialog.showModal();
    elements.saveName.focus();
}

function collectSavePayload() {
    const front = state.scenes.front;
    const back = state.scenes.back;

    if (!front.background.src || !back.background.src) {
        return {
            error: config.edit
                ? 'Both sides need a design image. Use "Replace Front" / "Replace Back" when a file is missing.'
                : 'Upload a front and a back design image before saving.',
        };
    }

    const form = new FormData();

    form.append('name', elements.saveName.value.trim());
    form.append('status', elements.saveStatus.value);
    form.append('card_width', String(front.card.width));
    form.append('card_height', String(front.card.height));
    form.append('orientation', front.card.orientation);
    form.append('front_elements', JSON.stringify(sceneForSerialization('front')));
    form.append('back_elements', JSON.stringify(sceneForSerialization('back')));

    if (front.background.file) {
        form.append('front_image', front.background.file);
    }

    if (back.background.file) {
        form.append('back_image', back.background.file);
    }

    return { form };
}

async function submitSave({ saveAsNew = false } = {}) {
    if (state.saving) {
        return;
    }

    state.name = elements.saveName.value.trim();
    state.status = elements.saveStatus.value;

    if (!state.name) {
        renderSaveErrors({ name: ['Please give the template a name.'] });

        return;
    }

    const { form, error } = collectSavePayload();

    if (error) {
        renderSaveErrors({ name: [error] });

        return;
    }

    let url = config.storeUrl;

    if (saveAsNew) {
        form.append('_copy_from', String(config.templateId));
    } else if (config.edit) {
        form.append('_method', 'PUT');
        url = config.updateUrl;
    }

    state.saving = true;
    renderSaveErrors({});

    try {
        const response = await fetch(url, {
            method: 'POST',
            body: form,
            headers: {
                'X-CSRF-TOKEN': csrfToken(),
                'X-Requested-With': 'XMLHttpRequest',
                Accept: 'application/json',
            },
        });

        if (response.redirected || response.ok) {
            window.location.href = config.templateListUrl;

            return;
        }

        const payload = await response.json().catch(() => ({}));

        renderSaveErrors(payload.errors || { name: [payload.message || 'The template could not be saved.'] });
    } catch (error) {
        renderSaveErrors({ name: ['The template could not be saved. Please try again.'] });
    } finally {
        state.saving = false;
    }
}

function renderSaveErrors(errors) {
    const messages = Object.values(errors || {}).flat().filter(Boolean);

    if (!messages.length) {
        elements.saveErrors.hidden = true;
        elements.saveErrors.innerHTML = '';

        return;
    }

    elements.saveErrors.hidden = false;
    elements.saveErrors.innerHTML = `<ul>${messages.map((message) => `<li>${escapeHtml(message)}</li>`).join('')}</ul>`;
}

/* -------------------------------------------------------------------------
 | Global events
 ---------------------------------------------------------------------- */

function bindEvents() {
    root.addEventListener('click', onRootClick);
    elements.propertiesPanel.addEventListener('input', onPropertyInput);
    elements.propertiesPanel.addEventListener('change', onPropertyInput);
    elements.propertiesPanel.addEventListener('click', onPropertyClick);
    elements.layersPanel.addEventListener('click', onLayersClick);
    document.addEventListener('keydown', onKeyDown);

    elements.fileFront.addEventListener('change', (event) => onDesignFile(event, 'front'));
    elements.fileBack.addEventListener('change', (event) => onDesignFile(event, 'back'));

    elements.fileAsset.addEventListener('change', (event) => {
        const file = event.target.files?.[0];
        const targetId = state.replaceTargetId;
        const region = state.pendingAssetRect;

        event.target.value = '';

        if (!file) {
            state.pendingAssetRect = null;

            return;
        }

        if (region) {
            addReplacementImage(file);
        } else if (targetId) {
            replaceSelectedImage(file, state.pendingAssetKind);
        } else {
            addUploadedImage(file, state.pendingAssetKind);
        }
    });

    window.addEventListener('resize', () => {
        if (state.zoomMode === 'fit') {
            applyZoom();
        }
    });

    elements.cardWidth.addEventListener('change', applyCardInputs);
    elements.cardHeight.addEventListener('change', applyCardInputs);
    elements.cardOrientation.addEventListener('change', applyCardInputs);

    elements.saveForm.addEventListener('submit', (event) => {
        event.preventDefault();
        submitSave();
    });

    elements.customLabel.addEventListener('input', () => {
        elements.customKey.placeholder = keyFromLabel(elements.customLabel.value) || 'field_key';
    });
}

async function onRootClick(event) {
    const button = event.target.closest('[data-action]');

    if (!button || elements.propertiesPanel.contains(button) || elements.layersPanel.contains(button)) {
        return;
    }

    const { action, type, side, kind, key, label, panel } = button.dataset;

    switch (action) {
        case 'set-side':
            await switchSide(side);
            break;
        case 'add-element':
            await addElement(buildElement(type));
            break;
        case 'add-dynamic':
            await addDynamicField(key, label);
            break;
        case 'create-custom-field':
            await createCustomField();
            break;
        case 'insert-custom-field':
            await insertCustomField();
            break;
        case 'replace-text':
            await replaceExistingText();
            break;
        case 'upload-front':
            elements.fileFront.click();
            break;
        case 'upload-back':
            elements.fileBack.click();
            break;
        case 'upload-asset':
            state.replaceTargetId = null;
            state.pendingAssetRect = null;
            state.pendingAssetKind = kind || 'custom';
            elements.fileAsset.click();
            break;
        case 'detect-regions':
            await detectRegions();
            break;
        case 'add-editable-text':
            setRegionMode(!state.regionMode);
            break;
        case 'toggle-regions':
            toggleRegionGuides();
            break;
        case 'restore-artwork':
            await restoreArtwork();
            break;
        case 'zoom-in':
            state.zoomMode = 'manual';
            state.zoom = clamp((state.zoom || 1) * 1.2, 0.1, 4);
            applyZoom();
            break;
        case 'zoom-out':
            state.zoomMode = 'manual';
            state.zoom = clamp((state.zoom || 1) / 1.2, 0.1, 4);
            applyZoom();
            break;
        case 'zoom-fit':
            state.zoomMode = 'fit';
            applyZoom();
            break;
        case 'preview':
            await openPreview();
            break;
        case 'save':
            openSaveDialog();
            break;
        case 'save-submit':
            await submitSave();
            break;
        case 'save-as-new':
            await submitSave({ saveAsNew: true });
            break;
        case 'close-dialog':
            button.closest('dialog')?.close();
            break;
        case 'panel-tab':
            setActivePanel(panel);
            break;
        default:
            break;
    }
}

function setActivePanel(panel) {
    qsa('[data-action="panel-tab"]').forEach((tab) => {
        tab.classList.toggle('is-active', tab.dataset.panel === panel);
    });

    elements.propertiesPanel.hidden = panel !== 'properties';
    elements.layersPanel.hidden = panel !== 'layers';
}

async function onDesignFile(event, side) {
    const file = event.target.files?.[0];

    event.target.value = '';

    if (!file) {
        return;
    }

    try {
        await handleDesignUpload(side, file);
        showAlert(`${side === 'front' ? 'Front' : 'Back'} design loaded. The file is uploaded to storage when you save.`, 'info');
    } catch (error) {
        showAlert(error.message || 'The image could not be read.');
    }
}

async function applyCardInputs() {
    const card = currentCard();
    const width = clamp(parseInt(elements.cardWidth.value, 10) || card.width, 200, 5000);
    const height = clamp(parseInt(elements.cardHeight.value, 10) || card.height, 200, 5000);
    const orientation = elements.cardOrientation.value === 'portrait' ? 'portrait' : 'landscape';

    ['front', 'back'].forEach((side) => {
        state.scenes[side].card = { width, height, orientation };
    });

    markDirty();
    applyCardToInputs();
    await loadSide(state.side);
    updateDesignStates();
}

function onKeyDown(event) {
    if (isTypingTarget(event.target) || document.querySelector('dialog[open]')) {
        return;
    }

    const key = event.key;

    if ((key === 'Delete' || key === 'Backspace') && state.selectedId) {
        event.preventDefault();
        deleteSelected();

        return;
    }

    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'd') {
        event.preventDefault();
        duplicateSelected();

        return;
    }

    if (key === 'Escape') {
        if (state.regionMode) {
            setRegionMode(false);

            return;
        }

        selectObject(null);

        return;
    }

    const step = event.shiftKey ? 10 : 1;
    const nudges = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };

    if (nudges[key] && state.selectedId) {
        event.preventDefault();
        nudgeSelected(...nudges[key]);
    }
}

/* TEMP-DEBUG-HOOK */
window.__idcDebug = {
    get canvas() { return canvas; },
    state,
    objectFor,
    selectedObject,
    selectObject,
    currentScene,
    elements,
};

document.addEventListener('DOMContentLoaded', boot);