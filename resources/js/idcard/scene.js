/**
 * Fabric.js scene engine.
 *
 * Converts the framework free scene description (see schema.js) into real
 * fabric objects and back. It is shared by the builder (interactive) and by
 * the read only renderer used for template previews.
 */

import { fabric } from 'fabric';

import { codeImage } from './codes.js';
import {
    DEFAULT_CARD,
    IMAGE_TYPES,
    TEXT_TYPES,
    applyTransform,
    normalizeElement,
    normalizeKey,
    normalizeScene,
    round,
    resolveText,
} from './schema.js';

export const BACKGROUND_ID = '__background__';

let configured = false;

/**
 * Shared control styling for every object type.
 */
export function configureFabric() {
    if (configured) {
        return;
    }

    configured = true;

    fabric.Object.prototype.set({
        transparentCorners: false,
        cornerColor: '#ffffff',
        cornerStrokeColor: '#2563eb',
        borderColor: '#2563eb',
        cornerStyle: 'circle',
        cornerSize: 11,
        touchCornerSize: 22,
        borderScaleFactor: 1.5,
        padding: 2,
        centeredRotation: true,
    });
}

/**
 * Create the canvas used by the builder or the renderer.
 */
export function createCanvas(element, options = {}) {
    configureFabric();

    return new fabric.Canvas(element, {
        selection: options.selection !== false,
        preserveObjectStacking: true,
        renderOnAddRemove: false,
        backgroundColor: '#ffffff',
        ...options.fabric,
    });
}

/**
 * Resize the canvas so a card of the given size fits at the given zoom.
 */
export function applyCardSize(canvas, card = DEFAULT_CARD, zoom = 1) {
    const width = Math.round(card.width * zoom);
    const height = Math.round(card.height * zoom);

    canvas.setDimensions({ width, height });
    canvas.zoom = zoom;
    canvas.setViewportTransform([zoom, 0, 0, zoom, 0, 0]);

    return { width, height };
}

/**
 * Load a URL as a fabric image object.
 *
 * fabric 5 only ships the callback form of `Image.fromURL`: it returns
 * `undefined` instead of a promise, so awaiting it directly resolves to
 * `undefined` and the first `image.width` read throws. This wrapper resolves
 * only once the browser has actually decoded the bitmap and the fabric object
 * really carries its dimensions, and rejects otherwise so a broken image can
 * be handled without taking the whole scene down.
 */
function loadFabricImage(src) {
    return new Promise((resolve, reject) => {
        if (!src) {
            reject(new Error('Missing image source.'));

            return;
        }

        try {
            fabric.Image.fromURL(src, (image, isError) => {
                if (isError || !image || !image.width || !image.height) {
                    reject(new Error('The image could not be loaded.'));

                    return;
                }

                resolve(image);
            });
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * Fit the untouched base design inside the card, preserving its aspect ratio.
 */
export async function buildBackground(src, card = DEFAULT_CARD) {
    let image;

    try {
        image = await loadFabricImage(src);
    } catch (error) {
        return null;
    }

    const scale = Math.min(card.width / image.width, card.height / image.height);

    image.set({
        originX: 'left',
        originY: 'top',
        left: (card.width - image.width * scale) / 2,
        top: (card.height - image.height * scale) / 2,
        scaleX: scale,
        scaleY: scale,
        selectable: false,
        evented: false,
        hasControls: false,
        lockMovementX: true,
        lockMovementY: true,
        lockScalingX: true,
        lockScalingY: true,
        lockRotation: true,
        hoverCursor: 'default',
    });
    image.idcard = {
        id: BACKGROUND_ID,
        role: 'background',
        type: 'background',
        name: 'Background (original design)',
        locked: true,
    };

    return image;
}

/**
 * A clickable outline drawn over a piece of content found in the design image.
 *
 * Guides are an editing aid, never part of the saved card: they carry no
 * element id, cannot be moved, scaled or rotated, and clicking one turns that
 * rectangle into a real editable layer. The stroke width is divided by the zoom
 * so the dashed box keeps the same weight on screen at any zoom level.
 *
 * @param {{left:number, top:number, width:number, height:number, kind?:string, fontSize?:number}} region
 * @param {number} [zoom]
 */
export function buildRegionGuide(region, zoom = 1) {
    const graphic = region.kind === 'graphic';
    const scale = Math.max(zoom || 1, 0.01);

    const guide = new fabric.Rect({
        originX: 'left',
        originY: 'top',
        left: region.left,
        top: region.top,
        width: Math.max(region.width, 2),
        height: Math.max(region.height, 2),
        fill: graphic ? 'rgba(217, 119, 6, 0.10)' : 'rgba(37, 99, 235, 0.08)',
        stroke: graphic ? '#b45309' : '#2563eb',
        strokeWidth: 2 / scale,
        strokeDashArray: [7 / scale, 5 / scale],
        rx: 2 / scale,
        ry: 2 / scale,
        selectable: true,
        evented: true,
        hasControls: false,
        hasBorders: false,
        lockMovementX: true,
        lockMovementY: true,
        lockScalingX: true,
        lockScalingY: true,
        lockRotation: true,
        hoverCursor: 'pointer',
    });

    guide.idcard = {
        role: 'region-guide',
        region: { ...region },
    };

    guide.setCoords();

    return guide;
}

/**
 * A dashed rectangle used while the user drags out a new editable region.
 */
export function buildRegionDraft(rect, zoom = 1) {
    const scale = Math.max(zoom || 1, 0.01);
    const draft = new fabric.Rect({
        originX: 'left',
        originY: 'top',
        left: rect.left,
        top: rect.top,
        width: Math.max(rect.width, 1),
        height: Math.max(rect.height, 1),
        fill: 'rgba(37, 99, 235, 0.12)',
        stroke: '#2563eb',
        strokeWidth: 2 / scale,
        strokeDashArray: [7 / scale, 5 / scale],
        rx: 2 / scale,
        ry: 2 / scale,
        selectable: false,
        evented: false,
        hasControls: false,
        hasBorders: false,
    });

    draft.idcard = { role: 'region-draft' };

    draft.setCoords();

    return draft;
}

/**
 * Build a text layer (static text, dynamic field or terms block).
 */
function buildText(element, options) {
    const { data = {}, fields = [] } = options;
    const source = element.type === 'dynamic_text'
        ? resolveText(element, data, fields)
        : interpolate(element.text ?? '', data, fields);

    const object = new fabric.Textbox(applyTransform(source, element.textTransform), {
        originX: 'left',
        originY: 'top',
        left: element.left,
        top: element.top,
        width: element.width,
        fontSize: element.fontSize,
        fontFamily: element.fontFamily,
        fontWeight: element.fontWeight,
        fontStyle: element.italic ? 'italic' : 'normal',
        underline: element.underline,
        fill: element.fill,
        textAlign: element.textAlign,
        lineHeight: element.lineHeight,
        charSpacing: charSpacing(element.letterSpacing, element.fontSize),
        angle: element.angle,
        opacity: element.opacity,
        visible: element.visible,
        editable: options.interactive !== false && element.locked !== true,
        selectable: options.interactive !== false && element.locked !== true,
        evented: options.interactive !== false && element.locked !== true,
        hasControls: options.interactive !== false && element.locked !== true,
        hasBorders: options.interactive !== false && element.locked !== true,
        splitByGrapheme: false,
    });

    object.initDimensions();

    return object;
}

/**
 * Replace {{field}} tokens inside static text with real values when data is
 * available (and with a readable placeholder when it is not).
 */
export function interpolate(text, data = {}, fields = []) {
    return String(text ?? '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key) => {
        const normalized = normalizeKey(key);
        const value = data?.[normalized];

        if (value !== undefined && value !== null && String(value).trim() !== '') {
            return String(value);
        }

        const known = fields.find((field) => field.key === normalized);

        return known ? known.label : match;
    });
}

/**
 * Fabric stores letter spacing in per-mille of the font size.
 */
export function charSpacing(spacing, fontSize) {
    const size = Number(fontSize) || 1;

    return Math.round(((Number(spacing) || 0) / size) * 1000);
}

/**
 * Build a rectangle (or the cover / erase area).
 */
function buildRect(element) {
    return new fabric.Rect({
        originX: 'left',
        originY: 'top',
        left: element.left,
        top: element.top,
        width: element.width,
        height: element.height,
        rx: element.radius || 0,
        ry: element.radius || 0,
        fill: element.bg,
        stroke: element.strokeWidth > 0 ? element.stroke : null,
        strokeWidth: element.strokeWidth || 0,
        angle: element.angle,
        opacity: element.opacity,
        visible: element.visible,
    });
}

/**
 * Build a circle (an ellipse when the box is not square).
 */
function buildCircle(element) {
    const width = Math.max(element.width, 4);
    const height = Math.max(element.height, 4);

    return new fabric.Circle({
        originX: 'left',
        originY: 'top',
        left: element.left,
        top: element.top,
        radius: width / 2,
        scaleX: 1,
        scaleY: height / width,
        fill: element.bg,
        stroke: element.strokeWidth > 0 ? element.stroke : null,
        strokeWidth: element.strokeWidth || 0,
        angle: element.angle,
        opacity: element.opacity,
        visible: element.visible,
    });
}

/**
 * Build a straight line.
 */
function buildLine(element) {
    return new fabric.Line([0, 0, Math.max(element.width, 4), 0], {
        originX: 'left',
        originY: 'top',
        left: element.left,
        top: element.top,
        stroke: element.bg,
        strokeWidth: element.strokeWidth,
        fill: null,
        angle: element.angle,
        opacity: element.opacity,
        visible: element.visible,
    });
}

/**
 * The clip path used to give an image a circle or rounded frame.
 */
function buildClipPath(width, height, element, scale) {
    if (element.frame === 'circle') {
        return new fabric.Circle({
            originX: 'center',
            originY: 'center',
            radius: Math.min(width, height) / 2,
            left: 0,
            top: 0,
        });
    }

    if (element.frame === 'rounded' || element.radius > 0) {
        const radius = element.radius / Math.max(scale, 0.0001);

        return new fabric.Rect({
            originX: 'left',
            originY: 'top',
            left: -width / 2,
            top: -height / 2,
            width,
            height,
            rx: radius,
            ry: radius,
        });
    }

    return null;
}

/**
 * The visible outline drawn on top of a framed image.
 */
function buildBorder(width, height, element, scale) {
    if (element.strokeWidth <= 0) {
        return null;
    }

    if (element.frame === 'circle') {
        return new fabric.Circle({
            originX: 'center',
            originY: 'center',
            radius: Math.min(width, height) / 2,
            left: 0,
            top: 0,
            fill: 'transparent',
            stroke: element.stroke,
            strokeWidth: element.strokeWidth,
        });
    }

    const radius = element.frame === 'rounded' || element.radius > 0 ? element.radius / Math.max(scale, 0.0001) : 0;

    return new fabric.Rect({
        originX: 'left',
        originY: 'top',
        left: -width / 2,
        top: -height / 2,
        width,
        height,
        rx: radius,
        ry: radius,
        fill: 'transparent',
        stroke: element.stroke,
        strokeWidth: element.strokeWidth,
    });
}

/**
 * Placeholder shown while an image layer has no file yet.
 */
function buildPlaceholder(element) {
    const rect = new fabric.Rect({
        originX: 'left',
        originY: 'top',
        left: 0,
        top: 0,
        width: Math.max(element.width, 40),
        height: Math.max(element.height, 40),
        fill: 'rgba(37, 99, 235, 0.06)',
        stroke: '#2563eb',
        strokeWidth: 1,
        strokeDashArray: [6, 4],
        rx: Math.min(element.radius || 0, 40),
        ry: Math.min(element.radius || 0, 40),
    });

    const label = new fabric.Textbox(element.name || 'Image', {
        originX: 'center',
        originY: 'center',
        left: 0,
        top: 0,
        width: Math.max(element.width - 16, 40),
        fontSize: 14,
        fontFamily: 'Arial',
        fill: '#1d4ed8',
        textAlign: 'center',
    });

    return new fabric.Group([rect, label], {
        originX: 'left',
        originY: 'top',
        left: element.left,
        top: element.top,
        angle: element.angle,
        opacity: element.opacity,
        visible: element.visible,
    });
}

/**
 * Build an image layer (photo, logo, signature, QR code or barcode).
 *
 * Images are wrapped in a group whenever a frame or border is used, so the
 * outline always follows the shape instead of the raw bitmap bounds.
 */
async function buildImage(element, options) {
    const { data = {} } = options;
    const src = IMAGE_TYPES.includes(element.type) && !element.src
        ? (element.type === 'image' ? '' : codeImage(element, data))
        : element.src;

    if (!src) {
        return buildPlaceholder(element);
    }

    let image;

    try {
        image = await loadFabricImage(src);
    } catch (error) {
        return buildPlaceholder(element);
    }

    const boxWidth = Math.max(element.width, 4);
    const boxHeight = Math.max(element.height, 4);
    const ratioX = boxWidth / image.width;
    const ratioY = boxHeight / image.height;
    const scale = element.fit === 'fill' ? null : element.fit === 'contain' ? Math.min(ratioX, ratioY) : Math.max(ratioX, ratioY);

    image.set({
        originX: 'center',
        originY: 'center',
        left: 0,
        top: 0,
        scaleX: scale ?? ratioX,
        scaleY: scale ?? ratioY,
    });

    const clipPath = buildClipPath(image.width, image.height, element, scale ?? ratioX);

    if (clipPath) {
        image.clipPath = clipPath;
    }

    const border = buildBorder(image.width, image.height, element, scale ?? ratioX);
    const object = border
        ? new fabric.Group([image, border], { originX: 'left', originY: 'top' })
        : image;

    object.set({
        originX: 'left',
        originY: 'top',
        left: element.left,
        top: element.top,
        angle: element.angle,
        opacity: element.opacity,
        visible: element.visible,
    });

    if (border) {
        object.scaleX = boxWidth / (object.width || image.width * (scale ?? ratioX));
        object.scaleY = boxHeight / (object.height || image.height * (scale ?? ratioY));
    } else if (element.fit === 'fill') {
        object.left = element.left;
        object.top = element.top;
    } else {
        object.left = element.left + (boxWidth - image.width * image.scaleX) / 2;
        object.top = element.top + (boxHeight - image.height * image.scaleY) / 2;
    }

    return object;
}

/**
 * Turn one scene element into a fabric object.
 */
export async function buildElementObject(element, options = {}) {
    configureFabric();

    let object = null;

    switch (element.type) {
        case 'text':
        case 'dynamic_text':
        case 'terms':
            object = buildText(element, options);
            break;
        case 'cover':
        case 'rect':
            object = buildRect(element);
            break;
        case 'circle':
            object = buildCircle(element);
            break;
        case 'line':
            object = buildLine(element);
            break;
        case 'image':
        case 'qrcode':
        case 'barcode':
            object = await buildImage(element, options);
            break;
        default:
            object = null;
    }

    if (!object) {
        return null;
    }

    finalizeObject(object, element, options);

    return object;
}

/**
 * Apply the shared element state (position, rotation, visibility, lock) to an
 * object and tag it so the builder can find it again.
 */
export function finalizeObject(object, element, options = {}) {
    const interactive = options.interactive !== false;
    const locked = element.locked === true;

    object.set({
        left: element.left,
        top: element.top,
        angle: element.angle,
        opacity: element.opacity,
        visible: element.visible,
    });

    object.idcard = {
        id: element.id,
        type: element.type,
        name: element.name,
        locked,
    };

    if (!interactive) {
        object.set({
            selectable: false,
            evented: false,
            hasControls: false,
            hasBorders: false,
            lockMovementX: true,
            lockMovementY: true,
            lockScalingX: true,
            lockScalingY: true,
            lockRotation: true,
            hoverCursor: 'default',
        });

        if (typeof object.setCoords === 'function') {
            object.setCoords();
        }

        return object;
    }

    object.set({
        selectable: !locked,
        evented: !locked,
        hasControls: !locked,
        hasBorders: !locked,
        lockMovementX: locked,
        lockMovementY: locked,
        lockScalingX: locked,
        lockScalingY: locked,
        lockRotation: locked,
        lockUniScaling: false,
        hoverCursor: locked ? 'not-allowed' : 'move',
    });

    if (typeof object.setCoords === 'function') {
        object.setCoords();
    }

    return object;
}

/**
 * Load a whole side of a card onto a canvas (background first, then layers).
 */
export async function loadScene(canvas, scene, options = {}) {
    configureFabric();

    const normalized = normalizeScene(scene ?? {}, options.card ?? DEFAULT_CARD);
    const zoom = options.zoom ?? 1;

    canvas.clear();
    applyCardSize(canvas, normalized.card, zoom);
    canvas.backgroundColor = options.backgroundColor || '#ffffff';

    const backgroundSrc = options.backgroundSrc ?? scene?.background?.src ?? null;

    if (normalized.background.visible && backgroundSrc) {
        const background = await buildBackground(backgroundSrc, normalized.card);

        if (background) {
            background.visible = normalized.background.visible;
            canvas.add(background);
        }
    }

    for (const element of normalized.elements) {
        const object = await buildElementObject(element, options);

        if (object) {
            canvas.add(object);
        }
    }

    canvas.requestRenderAll();

    return normalized;
}

/**
 * Rebuild a single element, keeping its layer position and selection state.
 */
export async function replaceElementObject(canvas, oldObject, element, options = {}) {
    if (!oldObject) {
        return null;
    }

    const index = canvas.getObjects().indexOf(oldObject);
    const wasActive = canvas.getActiveObject() === oldObject;

    canvas.remove(oldObject);

    const object = await buildElementObject(element, options);

    if (!object) {
        return null;
    }

    if (index >= 0) {
        canvas.insertAt(object, index);
    } else {
        canvas.add(object);
    }

    canvas.requestRenderAll();

    if (wasActive && options.interactive !== false) {
        canvas.setActiveObject(object);
        object.setCoords();
    }

    return object;
}

/**
 * Read the live geometry of a fabric object back into its element definition.
 *
 * Scaling is baked into the element (font size / real size) so a template
 * always stores meaningful values instead of a scale factor.
 *
 * @returns {boolean} true when the object has to be rebuilt from the element.
 */
export function syncGeometry(object, element) {
    if (!object || !element || object.idcard?.role === 'background') {
        return false;
    }

    element.left = round(object.left, 2);
    element.top = round(object.top, 2);
    element.angle = round(object.angle || 0, 2);
    element.opacity = round(object.opacity ?? 1, 3);

    const scaleX = object.scaleX || 1;
    const scaleY = object.scaleY || 1;

    if (TEXT_TYPES.includes(element.type)) {
        if (Math.abs(scaleX - 1) > 0.005 || Math.abs(scaleY - 1) > 0.005) {
            element.fontSize = round(Math.min(400, Math.max(4, element.fontSize * scaleY)), 2);
            element.width = round(Math.min(20000, Math.max(4, element.width * scaleX)), 2);

            object.set({ scaleX: 1, scaleY: 1, fontSize: element.fontSize, width: element.width });
            object.initDimensions?.();
        }

        element.height = round((object.height || 0) * scaleY, 2);
        object.setCoords?.();

        return false;
    }

    if (element.type === 'circle') {
        const width = Math.max((object.radius || 1) * 2 * scaleX, 4);
        const height = Math.max((object.radius || 1) * 2 * scaleY, 4);

        element.width = round(width, 2);
        element.height = round(height, 2);

        object.set({ scaleX: 1, scaleY: height / width });
        object.setCoords?.();

        return false;
    }

    if (element.type === 'line') {
        const length = Math.max(object.getScaledWidth?.() || element.width, 4);

        element.width = round(length, 2);
        element.height = element.strokeWidth;

        object.set({ x2: length, scaleX: 1, scaleY: 1 });
        object.setCoords?.();

        return false;
    }

    if (element.type === 'rect' || element.type === 'cover') {
        const width = round(Math.max((object.width || 1) * scaleX, 4), 2);
        const height = round(Math.max((object.height || 1) * scaleY, 4), 2);

        element.width = width;
        element.height = height;

        object.set({ scaleX: 1, scaleY: 1, width, height });
        object.setCoords?.();

        return false;
    }

    if (IMAGE_TYPES.includes(element.type)) {
        element.width = round(Math.max(object.getScaledWidth?.() || element.width, 4), 2);
        element.height = round(Math.max(object.getScaledHeight?.() || element.height, 4), 2);

        return true;
    }

    element.width = round((object.width || element.width) * scaleX, 2);
    element.height = round((object.height || element.height) * scaleY, 2);

    return false;
}

/**
 * Serialize the canvas back into the portable scene description.
 */
export function serializeScene(canvas, store) {
    const objects = canvas.getObjects();
    const background = objects.find((object) => object.idcard?.role === 'background');
    const elements = [];

    for (const object of objects) {
        const id = object.idcard?.id;

        if (!id || object.idcard?.role === 'background') {
            continue;
        }

        const element = (store.elements || []).find((item) => item.id === id);

        if (element) {
            elements.push({ ...element });
        } else {
            elements.push(normalizeElement({ ...object.idcard, left: object.left, top: object.top }));
        }
    }

    return {
        version: 1,
        card: {
            width: Math.round(store.card.width),
            height: Math.round(store.card.height),
            orientation: store.card.orientation,
        },
        background: {
            visible: background ? background.visible !== false : true,
            locked: true,
        },
        custom_fields: (store.custom_fields || []).map((field) => ({ ...field })),
        elements,
        masks: (store.masks || []).map((mask) => ({ ...mask })),
    };
}