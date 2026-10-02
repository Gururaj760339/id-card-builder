/**
 * Shared, framework free description of an ID card builder scene.
 *
 * A scene describes one side of a card: the card size, the untouched base
 * design (stored separately as a file) and the customization layers drawn on
 * top of it. The builder writes these objects, the renderer reads them and the
 * server re-validates them (see App\Services\IdCard\IdCardSceneSanitizer).
 */

export const SCENE_VERSION = 1;

export const MAX_ELEMENTS = 300;

export const MAX_MASKS = 300;

export const DEFAULT_CARD = { width: 1011, height: 638, orientation: 'landscape' };

export const TEXT_TYPES = ['text', 'dynamic_text', 'terms'];

export const IMAGE_TYPES = ['image', 'qrcode', 'barcode'];

export const ELEMENT_TYPES = [...TEXT_TYPES, 'cover', ...IMAGE_TYPES, 'rect', 'circle', 'line'];

export const FITS = ['contain', 'cover', 'fill'];

export const FRAMES = ['none', 'circle', 'rounded'];

export const TRANSFORMS = ['none', 'uppercase', 'lowercase'];

export const DATA_SOURCES = ['field', 'custom'];

export const BARCODE_FORMATS = ['CODE128', 'CODE39', 'EAN13', 'EAN8', 'UPC', 'ITF'];

export const QR_ERROR_CORRECTION = ['L', 'M', 'Q', 'H'];

export const DEFAULT_FONT = 'Arial';

export const ELEMENT_LABELS = {
    text: 'Text',
    dynamic_text: 'Dynamic Field',
    terms: 'Terms & Conditions',
    cover: 'Cover / Erase Area',
    image: 'Image',
    qrcode: 'QR Code',
    barcode: 'Barcode',
    rect: 'Rectangle',
    circle: 'Circle',
    line: 'Line',
};

/**
 * Create a unique element id.
 */
export function uid(prefix = 'el') {
    const random = Math.random().toString(36).slice(2, 10);

    return `${prefix}_${Date.now().toString(36)}${random}`;
}

/**
 * Round a number for stable storage.
 */
export function round(value, precision = 2) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return 0;
    }

    const factor = 10 ** precision;

    return Math.round(number * factor) / factor;
}

/**
 * Clamp a number inside a range.
 *
 * A value that is not a finite number keeps `fallback` (the low bound by
 * default), so a scene missing a property never collapses a layer to nothing.
 */
export function clamp(value, min, max, fallback = min) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, number));
}

/**
 * Coerce to boolean.
 *
 * A missing value keeps the fallback so a scene written by an older version of
 * the builder does not suddenly lose its background or its layers.
 */
export function toBool(value, fallback = false) {
    if (value === null || value === undefined) {
        return fallback;
    }

    if (value === true || value === 1 || value === '1' || value === 'true') {
        return true;
    }

    if (value === false || value === 0 || value === '0' || value === 'false' || value === '') {
        return false;
    }

    return fallback;
}

/**
 * Only accept an image the builder itself stored, or a small inline PNG/JPEG.
 */
export function normalizeSource(value) {
    if (typeof value !== 'string') {
        return '';
    }

    const src = value.trim();

    if (src.includes('..')) {
        return '';
    }

    if (/^\/storage\/id-card-builder\/[A-Za-z0-9_\-./]+$/.test(src)) {
        return src;
    }

    if (/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(src)) {
        return src;
    }

    return '';
}

/**
 * Pick the first value that belongs to the list.
 */
export function oneOf(value, options, fallback) {
    return options.includes(value) ? value : fallback;
}

/**
 * Normalise a CSS colour to something safe for the canvas renderer.
 */
export function color(value, fallback = '#000000') {
    if (typeof value !== 'string') {
        return fallback;
    }

    const color = value.trim();

    if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) {
        return color;
    }

    if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d{1,3})\s*)?\)$/i.test(color)) {
        return color;
    }

    return fallback;
}

/**
 * Apply a text transform the same way the canvas renderer does.
 */
export function applyTransform(text, transform) {
    const value = String(text ?? '');

    if (transform === 'uppercase') {
        return value.toUpperCase();
    }

    if (transform === 'lowercase') {
        return value.toLowerCase();
    }

    return value;
}

/**
 * Normalise a dynamic field key (student_name, guardian_name, ...).
 */
export function normalizeKey(value) {
    const key = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');

    return /^[a-z][a-z0-9_]{0,59}$/.test(key) ? key : '';
}

/**
 * Turn "Guardian Name" into "guardian_name".
 */
export function keyFromLabel(label) {
    return normalizeKey(
        String(label ?? '')
            .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
            .replace(/[^A-Za-z0-9]+/g, '_'),
    );
}

/**
 * The value a dynamic layer renders when no data has been supplied yet.
 */
export function placeholderFor(element, fields = []) {
    if (element.placeholder) {
        return element.placeholder;
    }

    if (element.field) {
        const match = fields.find((field) => field.key === element.field);

        return match ? match.label : element.field.replace(/_/g, ' ');
    }

    return 'Value';
}

/**
 * Resolve the text of a dynamic layer from an optional data map.
 *
 * The builder never stores student data: a later system (for example a student
 * management system) passes { student_name: 'John Doe' } to the renderer and the
 * template is filled in.
 */
export function resolveText(element, data = {}, fields = []) {
    const source = element.dataSource || (element.field ? 'field' : 'custom');

    if (source === 'field') {
        const key = element.field || element.dataField;
        const value = data?.[key];

        if (value !== undefined && value !== null && String(value).trim() !== '') {
            return String(value);
        }

        return `[${placeholderFor(element, fields)}]`;
    }

    const custom = element.dataValue ?? element.text ?? '';

    if (String(custom).trim() === '') {
        return `[${element.dataField || element.field || 'value'}]`;
    }

    return String(custom);
}

/**
 * Default values for a brand new element of the given type.
 */
export function defaultElement(type, overrides = {}) {
    const base = {
        id: uid(),
        name: ELEMENT_LABELS[type] || 'Element',
        type,
        left: 40,
        top: 40,
        width: 240,
        height: 44,
        angle: 0,
        opacity: 1,
        visible: true,
        locked: false,
    };

    const perType = {
        text: {
            text: 'Custom text',
            fontFamily: DEFAULT_FONT,
            fontSize: 22,
            fontWeight: 'normal',
            italic: false,
            underline: false,
            fill: '#111111',
            textAlign: 'left',
            lineHeight: 1.16,
            letterSpacing: 0,
            textTransform: 'none',
        },
        dynamic_text: {
            text: '',
            field: 'student_name',
            placeholder: '',
            fontFamily: DEFAULT_FONT,
            fontSize: 22,
            fontWeight: 'normal',
            italic: false,
            underline: false,
            fill: '#111111',
            textAlign: 'left',
            lineHeight: 1.16,
            letterSpacing: 0,
            textTransform: 'none',
        },
        terms: {
            text: '1. This card must be carried at all times.\n2. This card remains property of the institution.\n3. If found, please return it to the institution.\n4. Unauthorized use is prohibited.',
            fontFamily: DEFAULT_FONT,
            fontSize: 13,
            fontWeight: 'normal',
            italic: false,
            underline: false,
            fill: '#1f2937',
            textAlign: 'left',
            lineHeight: 1.3,
            letterSpacing: 0,
            textTransform: 'none',
        },
        cover: {
            bg: '#ffffff',
            radius: 0,
            strokeWidth: 0,
            stroke: '#000000',
            width: 220,
            height: 36,
        },
        rect: {
            bg: '#1d4ed8',
            radius: 0,
            strokeWidth: 0,
            stroke: '#0f172a',
            width: 200,
            height: 120,
        },
        circle: {
            bg: '#1d4ed8',
            strokeWidth: 0,
            stroke: '#0f172a',
            width: 140,
            height: 140,
        },
        line: {
            bg: '#111111',
            strokeWidth: 3,
            width: 240,
            height: 4,
        },
        image: {
            src: '',
            fit: 'cover',
            frame: 'none',
            radius: 0,
            strokeWidth: 0,
            stroke: '#111111',
            width: 200,
            height: 200,
        },
        qrcode: {
            src: '',
            fit: 'contain',
            frame: 'none',
            radius: 0,
            strokeWidth: 0,
            stroke: '#111111',
            dataSource: 'field',
            dataField: 'student_id',
            dataValue: '',
            qrEcc: 'M',
            width: 140,
            height: 140,
        },
        barcode: {
            src: '',
            fit: 'contain',
            frame: 'none',
            radius: 0,
            strokeWidth: 0,
            stroke: '#111111',
            dataSource: 'field',
            dataField: 'student_id',
            dataValue: '',
            barcodeFormat: 'CODE128',
            width: 260,
            height: 90,
        },
    };

    return { ...base, ...(perType[type] || perType.text), ...overrides };
}

/**
 * Rebuild an element from untrusted JSON using only known, bounded values.
 */
export function normalizeElement(raw = {}) {
    const type = oneOf(raw.type, ELEMENT_TYPES, 'text');
    const element = defaultElement(type, {
        id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 40) : uid(),
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 120) : ELEMENT_LABELS[type],
    });

    element.left = round(clamp(raw.left, -20000, 20000), 2);
    element.top = round(clamp(raw.top, -20000, 20000), 2);
    element.width = round(clamp(raw.width, 4, 20000), 2);
    element.height = round(clamp(raw.height, 4, 20000), 2);
    element.angle = round(clamp(raw.angle, -360, 360), 2);
    element.opacity = round(clamp(raw.opacity, 0, 1, 1), 3);
    element.visible = toBool(raw.visible, true);
    element.locked = toBool(raw.locked, false);

    if (TEXT_TYPES.includes(type)) {
        element.text = String(raw.text ?? '').slice(0, 4000);
        element.field = normalizeKey(raw.field);
        element.placeholder = typeof raw.placeholder === 'string' ? raw.placeholder.slice(0, 120) : '';
        element.fontFamily = typeof raw.fontFamily === 'string' && raw.fontFamily.trim() ? raw.fontFamily.trim().slice(0, 60) : DEFAULT_FONT;
        element.fontSize = round(clamp(raw.fontSize, 4, 400), 2);
        element.fontWeight = ['bold', 'normal', 'lighter', 'bolder'].includes(raw.fontWeight) ? raw.fontWeight : Number(raw.fontWeight) || 'normal';
        element.italic = toBool(raw.italic, false);
        element.underline = toBool(raw.underline, false);
        element.fill = color(raw.fill, '#111111');
        element.textAlign = oneOf(raw.textAlign, ['left', 'center', 'right', 'justify'], 'left');
        element.lineHeight = round(clamp(raw.lineHeight, 0.5, 5), 2);
        element.letterSpacing = round(clamp(raw.letterSpacing, -20, 60), 2);
        element.textTransform = oneOf(raw.textTransform, TRANSFORMS, 'none');
    }

    if (IMAGE_TYPES.includes(type)) {
        element.src = normalizeSource(raw.src);
        element.fit = oneOf(raw.fit, FITS, 'cover');
        element.frame = oneOf(raw.frame, FRAMES, 'none');
        element.radius = round(clamp(raw.radius, 0, 2000), 2);
        element.strokeWidth = round(clamp(raw.strokeWidth, 0, 40), 2);
        element.stroke = color(raw.stroke, '#111111');
    }

    if (type === 'qrcode' || type === 'barcode') {
        element.dataSource = oneOf(raw.dataSource, DATA_SOURCES, 'field');
        element.dataField = normalizeKey(raw.dataField ?? raw.field);
        element.dataValue = String(raw.dataValue ?? '').slice(0, 500);
        element.qrEcc = oneOf(raw.qrEcc, QR_ERROR_CORRECTION, 'M');
        element.barcodeFormat = oneOf(raw.barcodeFormat, BARCODE_FORMATS, 'CODE128');
    }

    if (type === 'cover' || type === 'rect') {
        element.bg = color(raw.bg, type === 'cover' ? '#ffffff' : '#1d4ed8');
        element.radius = round(clamp(raw.radius, 0, 2000), 2);
        element.strokeWidth = round(clamp(raw.strokeWidth, 0, 40), 2);
        element.stroke = color(raw.stroke, '#111111');
    }

    if (type === 'circle') {
        element.bg = color(raw.bg, '#1d4ed8');
        element.strokeWidth = round(clamp(raw.strokeWidth, 0, 40), 2);
        element.stroke = color(raw.stroke, '#111111');
    }

    if (type === 'line') {
        element.bg = color(raw.bg, '#111111');
        element.strokeWidth = round(clamp(raw.strokeWidth, 1, 40), 2);
    }

    return element;
}

/**
 * Rebuild one erased region of the base design from untrusted JSON.
 *
 * A mask is the rectangle of flattened artwork that has been removed from the
 * uploaded bitmap. It is stored with the scene - not with the layer it belongs
 * to - so that moving a layer never brings the original lettering back.
 *
 * `elementId` is the optional link back to the layer the mask was cut for. It is
 * what makes "Delete this layer" mean "this layer and the hole that was cut for
 * it, nothing else": a mask that was cut by hand (Cover / Erase Area) carries no
 * link and is therefore never removed with a layer.
 */
export function normalizeMask(raw = {}) {
    return {
        id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 40) : uid('mk'),
        left: round(clamp(raw.left, -20000, 20000), 2),
        top: round(clamp(raw.top, -20000, 20000), 2),
        width: round(clamp(raw.width, 1, 20000), 2),
        height: round(clamp(raw.height, 1, 20000), 2),
        elementId: typeof raw.elementId === 'string' && raw.elementId
            ? raw.elementId.slice(0, 40)
            : null,
    };
}

/**
 * Rebuild a whole side of a card.
 */
export function normalizeScene(raw = {}, fallbackCard = DEFAULT_CARD) {
    const card = raw.card || {};
    const background = raw.background || {};

    return {
        version: SCENE_VERSION,
        card: {
            width: Math.round(clamp(card.width ?? fallbackCard.width, 200, 5000)),
            height: Math.round(clamp(card.height ?? fallbackCard.height, 200, 5000)),
            orientation: card.orientation === 'portrait' ? 'portrait' : 'landscape',
        },
        background: {
            visible: toBool(background.visible, true),
            locked: true,
        },
        custom_fields: (Array.isArray(raw.custom_fields) ? raw.custom_fields : [])
            .map((field) => ({
                key: normalizeKey(field?.key),
                label: String(field?.label ?? '').trim().slice(0, 120),
            }))
            .filter((field) => field.key && field.label)
            .slice(0, 200),
        elements: (Array.isArray(raw.elements) ? raw.elements : [])
            .filter((element) => element && typeof element === 'object')
            .slice(0, MAX_ELEMENTS)
            .map(normalizeElement),
        masks: (Array.isArray(raw.masks) ? raw.masks : [])
            .filter((mask) => mask && typeof mask === 'object')
            .slice(0, MAX_MASKS)
            .map(normalizeMask),
    };
}

/**
 * A brand new, empty side of a card.
 */
export function emptyScene(card = DEFAULT_CARD) {
    return normalizeScene({ card, elements: [], masks: [], background: { visible: true } }, card);
}