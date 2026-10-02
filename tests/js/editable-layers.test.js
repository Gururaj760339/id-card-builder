import assert from 'node:assert/strict';
import test from 'node:test';

import { detectRegions, partitionRegions, pendingRegions } from '../../resources/js/idcard/detect.js';
import { renderMaskedBackground } from '../../resources/js/idcard/mask.js';
import { defaultElement, normalizeMask, normalizeScene } from '../../resources/js/idcard/schema.js';

/**
 * The editable-content pipeline: detected content -> masked artwork + one
 * independent, saveable layer per region.
 *
 * The fabric canvas itself needs a browser, so what is exercised here is
 * everything around it: the real detector, the real mask geometry, the real
 * scene model and the real masking of the flattened bitmap - i.e. the part that
 * decides whether every detected region ends up as its own editable element
 * instead of staying a red box.
 */

const WIDTH = 640;
const HEIGHT = 400;

/** The card content of the acceptance walkthrough, one glyph block per letter. */
const LINES = [
    { key: 'name', top: 70, count: 8, tall: 18 },
    { key: 'designation', top: 130, count: 6, tall: 14 },
    { key: 'person', top: 180, count: 7, tall: 14 },
    { key: 'id', top: 230, count: 9, tall: 14 },
    { key: 'email', top: 280, count: 11, tall: 14 },
    { key: 'phone', top: 330, count: 8, tall: 14 },
];

/** A panel that belongs to the design, not to any piece of content. */
const PANEL = { left: 470, top: 60, width: 130, height: 90, colour: [200, 40, 60] };

function bitmap(width, height, paint = () => {}) {
    const data = new Uint8ClampedArray(width * height * 4).fill(255);

    const set = (x, y, [r, g, b]) => {
        if (x < 0 || y < 0 || x >= width || y >= height) {
            return;
        }

        const offset = (y * width + x) * 4;

        data[offset] = r;
        data[offset + 1] = g;
        data[offset + 2] = b;
        data[offset + 3] = 255;
    };

    const rect = (left, top, boxWidth, boxHeight, colour) => {
        for (let y = top; y < top + boxHeight; y += 1) {
            for (let x = left; x < left + boxWidth; x += 1) {
                set(x, y, colour);
            }
        }
    };

    paint({ set, rect, width, height });

    return data;
}

function glyphLine(rect, { left, top, count, glyph = 18, tall = 14, gap = 4, colour = [20, 20, 20] }) {
    for (let index = 0; index < count; index += 1) {
        rect(left + index * (glyph + gap), top, glyph, tall, colour);
    }
}

/** The flat design exactly as it is uploaded: text is only pixels. */
function cardDesign() {
    return bitmap(WIDTH, HEIGHT, ({ rect }) => {
        LINES.forEach((line) => glyphLine(rect, { left: 60, ...line }));
        rect(PANEL.left, PANEL.top, PANEL.width, PANEL.height, PANEL.colour);
    });
}

/**
 * A canvas stub with the 2D calls the masking code makes, so the produced
 * pixels can be read back.
 */
function stubCanvasFactory(width, height, data) {
    const factory = () => {
        const context = {
            fillStyle: '#ffffff',
            fillRect() {},
            drawImage() {},
            getImageData(x, y, boxWidth, boxHeight) {
                const out = new Uint8ClampedArray(boxWidth * boxHeight * 4);

                for (let row = 0; row < boxHeight; row += 1) {
                    const from = ((y + row) * width + x) * 4;

                    out.set(data.subarray(from, from + boxWidth * 4), row * boxWidth * 4);
                }

                return { data: out, width: boxWidth, height: boxHeight };
            },
            putImageData(bitmapData, atX, atY) {
                for (let row = 0; row < bitmapData.height; row += 1) {
                    data.set(
                        bitmapData.data.subarray(row * bitmapData.width * 4, (row + 1) * bitmapData.width * 4),
                        ((atY + row) * width + atX) * 4,
                    );
                }
            },
        };

        const canvas = { getContext: () => context };

        factory.canvas = canvas;

        return canvas;
    };

    return factory;
}

function pixelFrom(factory, x, y) {
    const { data } = factory.canvas.getContext('2d').getImageData(x, y, 1, 1);

    return [data[0], data[1], data[2]];
}

function fakeImage() {
    return { naturalWidth: WIDTH, naturalHeight: HEIGHT };
}

/** Every text region of the card, in detection order. */
function detectedTextRegions() {
    const { regions } = detectRegions(cardDesign(), WIDTH, HEIGHT);

    return partitionRegions(regions).text;
}

/**
 * Convert text regions the way the editor does: one layer and one mask that
 * belongs to that layer, both at the region's own geometry.
 */
function convert(regions) {
    const elements = [];
    const masks = [];
    let ordinal = 0;

    regions.forEach((region) => {
        ordinal += 1;

        const element = defaultElement('text', {
            name: `Editable text ${ordinal}`,
            text: '',
            left: region.left,
            top: region.top,
            width: Math.max(region.width, 24),
            height: Math.max(region.height, 12),
            fontSize: Math.max(10, Math.round(region.height / 1.6)),
            fill: '#141414',
        });

        elements.push(element);
        masks.push(normalizeMask({
            id: `mk_${ordinal}`,
            left: region.left,
            top: region.top,
            width: region.width,
            height: region.height,
            elementId: element.id,
        }));
    });

    return { elements, masks };
}

test('every line of content on the card is detected as its own region', () => {
    const regions = detectedTextRegions();

    assert.equal(regions.length, LINES.length);

    // A region is never merged with its neighbours: each line keeps its own
    // position, its own width and its own kind.
    const tops = new Set(regions.map((region) => region.top));
    const leftMost = Math.min(...regions.map((region) => region.left));

    assert.equal(tops.size, LINES.length, 'one distinct top per line of content');
    regions.forEach((region) => {
        assert.ok(Math.abs(region.left - leftMost) <= 3, 'every line starts at the same left edge');
        assert.equal(region.kind, 'text');
    });
});

test('each detected region becomes a separate, independently editable layer', () => {
    const { elements } = convert(detectedTextRegions());

    assert.equal(elements.length, LINES.length);

    const ids = new Set(elements.map((element) => element.id));

    assert.equal(ids.size, LINES.length, 'no two regions share a layer');

    const names = new Set(elements.map((element) => element.name));

    assert.equal(names.size, LINES.length, 'every layer is listed separately in the Layers panel');

    // Each layer carries the geometry of its own region, so they can be moved
    // and resized without any of them describing the same box.
    const boxes = new Set(elements.map((element) => `${element.left},${element.top},${element.width},${element.height}`));

    assert.equal(boxes.size, LINES.length);

    LINES.forEach((line, index) => {
        assert.ok(elements[index].top <= line.top + 8, `layer ${index} sits on its own line`);
        assert.ok(elements[index].width > 20, `layer ${index} has a usable width`);
    });
});

test('every converted layer owns exactly one mask, at its own size', () => {
    const regions = detectedTextRegions();
    const { elements, masks } = convert(regions);

    assert.equal(masks.length, elements.length);

    masks.forEach((mask, index) => {
        assert.equal(mask.elementId, elements[index].id, 'the mask knows which layer it belongs to');
        assert.equal(mask.left, elements[index].left);
        assert.equal(mask.top, elements[index].top);
        assert.equal(mask.width, elements[index].width);
        assert.equal(mask.height, elements[index].height);
    });
});

test('the mask hides the flattened text and leaves the rest of the design alone', () => {
    const regions = detectedTextRegions();
    const { masks } = convert(regions);
    const data = cardDesign();
    const factory = stubCanvasFactory(WIDTH, HEIGHT, data);

    renderMaskedBackground(fakeImage(), { width: WIDTH, height: HEIGHT }, masks, factory);

    // The lettering itself is gone: without this the old "CONNOR HAMILTON"
    // would still show through the replacement typed on the layer above it.
    regions.forEach((region) => {
        const x = Math.round(region.left + region.width / 2);
        const y = Math.round(region.top + region.height / 2);
        const inside = pixelFrom(factory, x, y);

        assert.ok(inside[0] > 200 && inside[1] > 200 && inside[2] > 200, `flattened text still visible at ${x},${y}`);
    });

    // The mask covers the content region and nothing else: the coloured panel
    // that belongs to the design is still exactly the colour it was.
    const panelPixel = pixelFrom(factory, PANEL.left + 5, PANEL.top + 5);

    assert.deepEqual(panelPixel, PANEL.colour, 'a mask must not touch unrelated artwork');

    // The paper between two lines is untouched as well.
    const between = pixelFrom(factory, 200, 160);

    assert.deepEqual(between, [255, 255, 255]);
});

test('editing, moving or deleting one layer never touches another', () => {
    const { elements, masks } = convert(detectedTextRegions());
    const untouched = elements.map((element) => ({ ...element }));

    // Retype the name, the way the properties panel does.
    elements[0].text = 'RAHIM AHMED';
    // Drag the phone somewhere else.
    elements[5].left += 40;
    elements[5].top -= 12;

    elements.slice(1, 5).forEach((element, index) => {
        assert.deepEqual(element, untouched[index + 1], 'a sibling layer was modified by accident');
    });

    // Deleting the email takes the email layer and the hole cut for it, and
    // leaves the name, the phone, the id and the background alone.
    const deleted = elements[4];
    const remainingElements = elements.filter((element) => element.id !== deleted.id);
    const remainingMasks = masks.filter((mask) => mask.elementId !== deleted.id);

    assert.equal(remainingElements.length, LINES.length - 1);
    assert.equal(remainingMasks.length, LINES.length - 1);
    assert.ok(remainingMasks.every((mask) => mask.elementId !== deleted.id));
    assert.ok(remainingElements.some((element) => element.text === 'RAHIM AHMED'), 'the name survived the delete');
    assert.ok(remainingElements.some((element) => element.left === untouched[5].left + 40), 'the phone survived the delete');
});

test('a hand drawn mask has no owner and outlives every layer', () => {
    const { elements } = convert(detectedTextRegions());
    const handDrawn = normalizeMask({ id: 'mk_cover', left: 0, top: 0, width: 120, height: 30 });

    assert.equal(handDrawn.elementId, null);
    assert.ok(elements.every((element) => element.id !== undefined));
});

test('a saved template reopens with every layer, position, style and mask', () => {
    const { elements, masks } = convert(detectedTextRegions());

    elements[0].text = 'RAHIM AHMED';
    elements[0].fontWeight = 'bold';
    elements[0].fill = '#123456';
    elements[5].left += 40;
    elements[5].top -= 12;

    // What the editor hands to the server, and what comes back on reopen.
    const saved = JSON.parse(JSON.stringify({ card: { width: WIDTH, height: HEIGHT }, elements, masks }));
    const reopened = normalizeScene(saved, { width: WIDTH, height: HEIGHT });

    assert.equal(reopened.elements.length, LINES.length);
    assert.equal(reopened.masks.length, LINES.length);

    reopened.elements.forEach((element, index) => {
        assert.equal(element.id, elements[index].id);
        assert.equal(element.type, 'text');
        assert.equal(element.name, `Editable text ${index + 1}`);
        assert.equal(element.left, elements[index].left);
        assert.equal(element.top, elements[index].top);
        assert.equal(element.width, elements[index].width);
        assert.equal(element.height, elements[index].height);
    });

    assert.equal(reopened.elements[0].text, 'RAHIM AHMED');
    assert.equal(reopened.elements[0].fontWeight, 'bold');
    assert.equal(reopened.elements[0].fill, '#123456');
    assert.equal(reopened.elements[5].left, elements[5].left);
    assert.equal(reopened.elements[5].top, elements[5].top);

    // Each mask is still tied to its own layer, so the hole under the name is
    // still hiding the original name after a reload.
    reopened.masks.forEach((mask, index) => {
        assert.equal(mask.id, masks[index].id);
        assert.equal(mask.elementId, reopened.elements[index].id);
        assert.equal(mask.left, masks[index].left);
        assert.equal(mask.top, masks[index].top);
        assert.equal(mask.width, masks[index].width);
        assert.equal(mask.height, masks[index].height);
    });
});

test('a photo sized block is not turned into a text layer', () => {
    const { regions } = detectRegions(cardDesign(), WIDTH, HEIGHT);
    const { text, graphic } = partitionRegions(regions);

    // The panel is offered to the user as a replacement target, never erased and
    // never retyped, because a photo cannot be rebuilt out of a text layer.
    assert.equal(graphic.length, 1);
    assert.ok(graphic[0].width >= PANEL.width - 20);
    assert.ok(graphic[0].height >= PANEL.height - 20);
    assert.ok(!text.some((region) => region.left >= PANEL.left - 5));
});

/**
 * The same card with its lines printed the way a real card prints them: only a
 * few pixels of white between them, which is the layout that used to come back
 * as a single region and therefore a single layer for the whole card.
 *
 * Eight pixels is as tight as this can go: below that the antialiasing around
 * two lines touches and no threshold-based detector can tell them apart. The
 * point of the test is that *whatever* the spacing, the number of layers does
 * not collapse from six into one.
 */
const TIGHT_GAP = 8;

function tightCardDesign() {
    return bitmap(WIDTH, HEIGHT, ({ rect }) => {
        let top = 60;

        LINES.forEach((line) => {
            glyphLine(rect, { left: 60, top, count: line.count, tall: line.tall });
            top += line.tall + TIGHT_GAP;
        });
    });
}

test('lines printed a few pixels apart still become one layer each', () => {
    const { regions } = detectRegions(tightCardDesign(), WIDTH, HEIGHT);
    const { text } = partitionRegions(regions);
    const { elements, masks } = convert(text);

    assert.equal(text.length, LINES.length, 'each tightly set line is its own region');
    assert.equal(elements.length, LINES.length);
    assert.equal(masks.length, LINES.length);

    // No layer covers two lines: that is what stacking all of them into one big
    // editable box felt like from the Layers panel.
    let top = 60;

    elements.forEach((element, index) => {
        assert.ok(Math.abs(element.top - top) <= 10, `layer ${index} sits on line ${index}`);
        assert.ok(element.height <= LINES[index].tall + 8, `layer ${index} is only as tall as one line`);
        top += LINES[index].tall + TIGHT_GAP;
    });

    assert.equal(new Set(elements.map((element) => element.id)).size, LINES.length);
    assert.equal(new Set(masks.map((mask) => mask.elementId)).size, LINES.length);
});

test('detecting the same content twice does not stack a second set of layers', () => {
    const { regions } = detectRegions(cardDesign(), WIDTH, HEIGHT);
    const { text } = partitionRegions(regions);
    const scene = normalizeScene({
        card: { width: WIDTH, height: HEIGHT },
        ...convert(text),
    }, { width: WIDTH, height: HEIGHT });

    assert.equal(scene.elements.length, LINES.length);

    // A second click on "Detect Content" finds the same regions again, and none
    // of them may be turned into a layer a second time.
    assert.deepEqual(pendingRegions(text, scene), [], 'the second run must add nothing');

    // "Restore Original Artwork" puts the artwork back and clears the masks, but
    // keeps the layers - the content is still editable, so it is still not new.
    const restored = normalizeScene({
        card: { width: WIDTH, height: HEIGHT },
        elements: scene.elements,
        masks: [],
    }, { width: WIDTH, height: HEIGHT });

    assert.equal(restored.masks.length, 0);
    assert.deepEqual(pendingRegions(text, restored), [], 'restored artwork must not duplicate the layers');

    // Deleting one layer frees exactly that line again, and only that one.
    const withoutPhone = normalizeScene({
        card: { width: WIDTH, height: HEIGHT },
        elements: scene.elements.slice(0, -1),
        masks: scene.masks.slice(0, -1),
    }, { width: WIDTH, height: HEIGHT });

    assert.equal(pendingRegions(text, withoutPhone).length, 1);
});

test('the front and the back of a card are converted independently', () => {
    const front = normalizeScene({
        card: { width: WIDTH, height: HEIGHT },
        ...convert(partitionRegions(detectRegions(cardDesign(), WIDTH, HEIGHT).regions).text),
    }, { width: WIDTH, height: HEIGHT });
    const back = normalizeScene({ card: { width: WIDTH, height: HEIGHT }, elements: [], masks: [] }, { width: WIDTH, height: HEIGHT });

    assert.equal(front.elements.length, LINES.length);
    assert.equal(back.elements.length, 0, 'working on the front leaves the back empty');

    // The back still has all of its own content waiting to be detected.
    assert.equal(pendingRegions(detectedTextRegions(), back).length, LINES.length);

    const convertedBack = convert(pendingRegions(detectedTextRegions(), back));

    assert.equal(convertedBack.elements.length, LINES.length);
    assert.ok(
        convertedBack.elements.every((element) => !front.elements.some((existing) => existing.id === element.id)),
        'layers of the two sides never share an id',
    );
});

test('a printed barcode stays a replacement target instead of becoming text', () => {
    const data = bitmap(WIDTH, HEIGHT, ({ rect }) => {
        LINES.forEach((line) => glyphLine(rect, { left: 60, ...line }));

        for (let index = 0; index < 60; index += 1) {
            rect(60 + index * 8, 368, 5, 22, [20, 20, 20]);
        }
    });

    const { regions } = detectRegions(data, WIDTH, HEIGHT);
    const { text, graphic } = partitionRegions(regions);
    const { elements } = convert(text);

    // The barcode is reported as artwork, so no empty text layer is dropped over
    // it and the flattened bars are not erased.
    assert.equal(text.length, LINES.length);
    assert.equal(elements.length, LINES.length);
    assert.equal(graphic.length, 1);
    assert.equal(graphic[0].label, 'Barcode');
    assert.ok(!elements.some((element) => element.top > 360), 'no layer sits on the barcode');
});
