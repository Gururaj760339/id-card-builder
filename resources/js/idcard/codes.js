/**
 * Client side QR code and barcode generation.
 *
 * Both are produced as PNG data URLs (same browser engine as the preview) and
 * drawn as normal image layers, which keeps them movable, resizable and
 * rotatable exactly like every other element.
 */

import qrcode from 'qrcode-generator';
import JsBarcode from 'jsbarcode';

const cache = new Map();

/**
 * Convert a letter spacing in pixels into fabric's per-mille unit.
 */
export function letterSpacingToCharSpacing(spacing, fontSize) {
    const size = Number(fontSize) || 1;

    return Math.round(((Number(spacing) || 0) / size) * 1000);
}

/**
 * Build the value encoded in a QR code or barcode layer.
 */
export function codeValue(element, data = {}) {
    if ((element.dataSource || 'field') === 'custom') {
        const custom = String(element.dataValue ?? '').trim();

        return custom === '' ? `id-card:${element.dataField || 'card'}` : custom;
    }

    const key = element.dataField || element.field || '';
    const value = data?.[key];

    if (value !== undefined && value !== null && String(value).trim() !== '') {
        return String(value);
    }

    return key ? `[${key}]` : 'ID-CARD';
}

/**
 * Render a QR code as a PNG data URL.
 */
export function qrDataUrl(value, errorCorrection = 'M', size = 640) {
    const ecc = ['L', 'M', 'Q', 'H'].includes(errorCorrection) ? errorCorrection : 'M';
    const cacheKey = `qr:${ecc}:${size}:${value}`;

    if (cache.has(cacheKey)) {
        return cache.get(cacheKey);
    }

    if (qrcode.stringToBytesFuncs && qrcode.stringToBytesFuncs['UTF-8']) {
        qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
    }

    const qr = qrcode(0, ecc);
    qr.addData(String(value ?? ''), 'Byte');
    qr.make();

    const modules = qr.getModuleCount();
    const cell = Math.max(2, Math.floor(size / modules));
    const canvas = document.createElement('canvas');

    canvas.width = modules * cell;
    canvas.height = modules * cell;

    const context = canvas.getContext('2d');

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000000';

    for (let row = 0; row < modules; row += 1) {
        for (let column = 0; column < modules; column += 1) {
            if (qr.isDark(row, column)) {
                context.fillRect(column * cell, row * cell, cell, cell);
            }
        }
    }

    const url = canvas.toDataURL('image/png');

    cache.set(cacheKey, url);

    return url;
}

/**
 * Render a barcode as a PNG data URL.
 */
export function barcodeDataUrl(value, format = 'CODE128', options = {}) {
    const symbology = ['CODE128', 'CODE39', 'EAN13', 'EAN8', 'UPC', 'ITF'].includes(format) ? format : 'CODE128';
    const showText = options.showText !== false;
    const height = Math.max(24, Math.round(options.height || 90));
    const cacheKey = `bar:${symbology}:${height}:${showText ? 1 : 0}:${value}`;

    if (cache.has(cacheKey)) {
        return cache.get(cacheKey);
    }

    const canvas = document.createElement('canvas');

    canvas.width = 8;
    canvas.height = height + (showText ? 22 : 0);

    try {
        JsBarcode(canvas, String(value ?? ''), {
            format: symbology,
            height,
            width: 2,
            displayValue: showText,
            fontSize: 14,
            font: 'Arial',
            textMargin: 2,
            margin: 4,
            background: '#ffffff',
            lineColor: '#000000',
        });
    } catch (error) {
        // An invalid value for the chosen symbology must never break the card.
        JsBarcode(canvas, 'UNSUPPORTED', {
            format: 'CODE128',
            height,
            width: 2,
            displayValue: false,
            margin: 4,
        });
    }

    const url = canvas.toDataURL('image/png');

    cache.set(cacheKey, url);

    return url;
}

/**
 * Build the image source for a QR / barcode layer.
 */
export function codeImage(element, data = {}) {
    const value = codeValue(element, data);

    if (element.type === 'barcode') {
        return barcodeDataUrl(value, element.barcodeFormat, { height: 120, showText: element.showText !== false });
    }

    return qrDataUrl(value, element.qrEcc, 640);
}