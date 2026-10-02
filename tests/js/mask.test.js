import assert from 'node:assert/strict';
import test from 'node:test';

import { detectDesignRegions } from '../../resources/js/idcard/detect.js';
import { renderMaskedBackground, sampleRegionColours } from '../../resources/js/idcard/mask.js';
import { normalizeScene } from '../../resources/js/idcard/schema.js';

/**
 * A canvas stub with just the 2D context calls the masking code makes.
 *
 * `paint` receives a `set(x, y, [r, g, b])` helper so a test can describe the
 * design it wants to mask.
 */
function stubCanvasFactory(width, height, paint = () => {}) {
    const factory = () => {
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

        const context = {
            fillStyle: '#000000',
            fillRect(x, y, boxWidth, boxHeight) {
                rect(x, y, boxWidth, boxHeight, [
                    parseInt(context.fillStyle.slice(1, 3), 16),
                    parseInt(context.fillStyle.slice(3, 5), 16),
                    parseInt(context.fillStyle.slice(5, 7), 16),
                ]);
            },
            drawImage() {},
            getImageData(x, y, boxWidth, boxHeight) {
                const out = new Uint8ClampedArray(boxWidth * boxHeight * 4);

                for (let row = 0; row < boxHeight; row += 1) {
                    const from = ((y + row) * width + x) * 4;
                    const to = (row * boxWidth) * 4;

                    out.set(data.subarray(from, from + boxWidth * 4), to);
                }

                return { data: out, width: boxWidth, height: boxHeight };
            },
            putImageData(bitmap, atX, atY) {
                for (let row = 0; row < bitmap.height; row += 1) {
                    const to = ((atY + row) * width + atX) * 4;
                    const from = (row * bitmap.width) * 4;

                    data.set(bitmap.data.subarray(from, from + bitmap.width * 4), to);
                }
            },
        };

        const canvas = { getContext: () => context };

        // Keep the most recent canvas so a test can read the pixels the masking
        // code actually produced.
        factory.canvas = canvas;

        return canvas;
    };

    return factory;
}

function fakeImage(naturalWidth, naturalHeight) {
    return { naturalWidth, naturalHeight };
}

/**
 * Read one pixel back out of the canvas the masking code produced.
 */
function pixelFrom(factory, x, y) {
    const data = factory.canvas.getContext('2d').getImageData(x, y, 1, 1).data;

    return [data[0], data[1], data[2]];
}

function makeDesign(width, height, paint) {
    return stubCanvasFactory(width, height, paint);
}

test('keeps the artwork untouched when there is nothing masked', () => {
    const factory = makeDesign(120, 80, ({ rect }) => {
        rect(10, 10, 40, 20, [0, 0, 0]);
    });

    const result = renderMaskedBackground(fakeImage(120, 80), { width: 120, height: 80 }, [], factory);

    assert.ok(result);
    assert.deepEqual(pixelFrom(factory, 20, 20), [0, 0, 0]);
});

test('erases a text line but keeps the surrounding panel colour', () => {
    const factory = makeDesign(160, 100, ({ rect }) => {
        // A light card with one dark line of lettering across the middle.
        rect(0, 0, 160, 100, [248, 246, 240]);
        rect(20, 48, 120, 12, [25, 25, 30]);
    });

    renderMaskedBackground(
        fakeImage(160, 100),
        { width: 160, height: 100 },
        [{ id: 'mk_1', left: 20, top: 48, width: 120, height: 12 }],
        factory,
    );

    const inside = pixelFrom(factory, 80, 54);

    // The dark pixels must be gone, replaced by the paper colour from above and
    // below rather than by a black box.
    assert.ok(inside[0] > 200 && inside[1] > 200 && inside[2] > 200, `expected paper colour, got ${inside}`);
});

test('erases a photo sized block inside a coloured panel', () => {
    const factory = makeDesign(200, 120, ({ rect }) => {
        rect(0, 0, 200, 120, [255, 255, 255]);
        rect(30, 30, 60, 50, [180, 30, 40]);
    });

    renderMaskedBackground(
        fakeImage(200, 120),
        { width: 200, height: 120 },
        [{ id: 'mk_photo', left: 30, top: 30, width: 60, height: 50 }],
        factory,
    );

    const inside = pixelFrom(factory, 60, 55);

    assert.ok(inside[0] > 150, `expected the red block to be gone, got ${inside}`);
});

test('clamps a mask that runs off the card instead of throwing', () => {
    const factory = makeDesign(100, 60, ({ rect }) => {
        rect(0, 0, 100, 60, [255, 255, 255]);
        rect(80, 10, 40, 20, [0, 0, 0]);
    });

    const result = renderMaskedBackground(
        fakeImage(100, 60),
        { width: 100, height: 60 },
        [{ id: 'mk_over', left: 80, top: 10, width: 900, height: 20 }],
        factory,
    );

    assert.ok(result);
    const inside = pixelFrom(factory, 90, 20);

    assert.ok(inside[0] > 200, `expected the overflow mask to be applied, got ${inside}`);
});

test('erases a heading that sits against the top edge of the card', () => {
    const factory = makeDesign(160, 100, ({ rect }) => {
        rect(0, 0, 160, 100, [250, 250, 248]);
        rect(20, 0, 120, 9, [18, 18, 18]);
    });

    const result = renderMaskedBackground(
        fakeImage(160, 100),
        { width: 160, height: 100 },
        [{ id: 'mk_head', left: 20, top: 0, width: 120, height: 9 }],
        factory,
    );

    assert.ok(result, 'a mask touching the top edge must not throw');

    const inside = pixelFrom(factory, 80, 4);

    assert.ok(inside[0] > 200 && inside[1] > 200 && inside[2] > 200, `expected the heading to be gone, got ${inside}`);
});

test('erases a footer line that sits against the bottom edge of the card', () => {
    const factory = makeDesign(160, 100, ({ rect }) => {
        rect(0, 0, 160, 100, [250, 250, 248]);
        rect(30, 91, 100, 9, [18, 18, 18]);
    });

    const result = renderMaskedBackground(
        fakeImage(160, 100),
        { width: 160, height: 100 },
        [{ id: 'mk_foot', left: 30, top: 91, width: 100, height: 9 }],
        factory,
    );

    assert.ok(result, 'a mask touching the bottom edge must not throw');

    const inside = pixelFrom(factory, 80, 95);

    assert.ok(inside[0] > 200 && inside[1] > 200 && inside[2] > 200, `expected the footer to be gone, got ${inside}`);
});

test('erases a corner block that touches two edges without throwing', () => {
    const factory = makeDesign(120, 90, ({ rect }) => {
        rect(0, 0, 120, 90, [255, 255, 255]);
        rect(0, 0, 40, 14, [30, 30, 30]);
    });

    const result = renderMaskedBackground(
        fakeImage(120, 90),
        { width: 120, height: 90 },
        [{ id: 'mk_corner', left: 0, top: 0, width: 40, height: 14 }],
        factory,
    );

    assert.ok(result, 'a mask touching two edges must not throw');
    assert.ok(pixelFrom(factory, 10, 6)[0] > 100, 'the corner block is gone');
});

test('ignores masks that are not finite numbers', () => {
    const factory = makeDesign(60, 40, () => {});

    const result = renderMaskedBackground(
        fakeImage(60, 40),
        { width: 60, height: 40 },
        [
            { left: Number.NaN, top: 5, width: 10, height: 10 },
            { left: 'x', top: 'y', width: 'w', height: 'h' },
            { left: 5, top: 5, width: 0, height: 10 },
        ],
        factory,
    );

    assert.ok(result);
});

test('returns null for an image that never decoded', () => {
    assert.equal(renderMaskedBackground({ naturalWidth: 0, naturalHeight: 0 }, { width: 10, height: 10 }), null);
    assert.equal(renderMaskedBackground(null, { width: 10, height: 10 }), null);
});

test('an image that is only half decoded is never measured', () => {
    // A width with no height (or the other way round) used to divide by zero and
    // produce a NaN box, which surfaced much later as a crash on an undefined
    // canvas, long after the upload that caused it.
    const broken = [
        { naturalWidth: 640, naturalHeight: 0 },
        { naturalWidth: 0, naturalHeight: 400 },
        { naturalWidth: NaN, naturalHeight: 400 },
        { naturalWidth: 640, naturalHeight: undefined },
    ];

    broken.forEach((image) => {
        assert.equal(renderMaskedBackground(image, { width: 10, height: 10 }), null);
        assert.deepEqual(
            sampleRegionColours(image, { width: 10, height: 10 }, { left: 0, top: 0, width: 5, height: 5 }),
            { fill: '#111111', background: '#ffffff', inkRatio: 0 },
        );
    });
});

test('a card size that is missing is never guessed from a broken image', () => {
    assert.deepEqual(detectDesignRegions(null, { width: 10, height: 10 }), []);
    assert.deepEqual(detectDesignRegions({ naturalWidth: 640 }, { width: 10, height: 10 }), []);
});

test('samples the ink colour of a line of lettering', () => {
    const factory = stubCanvasFactory(120, 80, ({ rect }) => {
        rect(0, 0, 120, 80, [255, 255, 255]);

        // Glyph sized strokes on white, i.e. what a text region really looks
        // like once you look at the pixels.
        for (let index = 0; index < 8; index += 1) {
            rect(12 + index * 12, 30, 7, 14, [16, 16, 16]);
        }
    });

    const colours = sampleRegionColours(
        fakeImage(120, 80),
        { width: 120, height: 80 },
        { left: 10, top: 30, width: 100, height: 16 },
        24,
        factory,
    );

    assert.equal(colours.fill, '#101010');
    assert.equal(colours.background, '#ffffff');
    assert.ok(colours.inkRatio > 0.2 && colours.inkRatio < 0.8, `expected mixed ink, got ${colours.inkRatio}`);
});

test('samples light lettering printed on a dark panel', () => {
    const factory = stubCanvasFactory(120, 80, ({ rect }) => {
        rect(0, 0, 120, 80, [255, 255, 255]);
        rect(10, 30, 100, 16, [24, 48, 96]);

        for (let index = 0; index < 8; index += 1) {
            rect(12 + index * 12, 32, 7, 12, [240, 240, 240]);
        }
    });

    const colours = sampleRegionColours(
        fakeImage(120, 80),
        { width: 120, height: 80 },
        { left: 10, top: 30, width: 100, height: 16 },
        24,
        factory,
    );

    assert.equal(colours.background, '#183060');
    assert.equal(colours.fill, '#f0f0f0');
});

test('falls back to a dark ink colour when a region is uniformly dark', () => {
    const factory = stubCanvasFactory(60, 40, ({ rect }) => {
        rect(0, 0, 60, 40, [255, 255, 255]);
        rect(5, 5, 40, 30, [10, 10, 10]);
    });

    const colours = sampleRegionColours(
        fakeImage(60, 40),
        { width: 60, height: 40 },
        { left: 5, top: 5, width: 40, height: 30 },
        24,
        factory,
    );

    assert.equal(colours.fill, '#111111');
    assert.equal(colours.background, '#0a0a0a');
});

test('refuses to sample a region that is entirely outside the card', () => {
    const factory = stubCanvasFactory(60, 40, () => {});

    const colours = sampleRegionColours(
        fakeImage(60, 40),
        { width: 60, height: 40 },
        { left: 500, top: 500, width: 20, height: 20 },
        24,
        factory,
    );

    assert.equal(colours.fill, '#111111');
    assert.equal(colours.inkRatio, 0);
});

test('a scene keeps its masks through normalisation', () => {
    const scene = normalizeScene(
        {
            card: { width: 640, height: 400 },
            masks: [
                { id: 'mk_a', left: 12.345, top: 20, width: 100, height: 30 },
                { id: 'mk_b', left: 5, top: 5, width: 50, height: 20 },
            ],
            elements: [],
        },
        { width: 640, height: 400 },
    );

    assert.equal(scene.masks.length, 2);
    assert.equal(scene.masks[0].left, 12.35);
    assert.equal(scene.masks[1].id, 'mk_b');
});

test('masks are bounded and always well formed', () => {
    const scene = normalizeScene(
        {
            masks: [
                { left: -99999, top: -99999, width: 99999, height: 99999 },
                { left: 'nope', top: null, width: undefined, height: 0 },
                'not an object',
                null,
            ],
            elements: [],
        },
        { width: 640, height: 400 },
    );

    assert.equal(scene.masks.length, 2);
    scene.masks.forEach((mask) => {
        assert.match(mask.id, /^mk_|^mk[a-z0-9_-]{0,38}$/);
        assert.ok(mask.width >= 1 && mask.height >= 1);
        assert.ok(Number.isFinite(mask.left) && Number.isFinite(mask.top));
    });
    assert.equal(scene.masks[1].width, 1);
    assert.equal(scene.masks[1].height, 1);
});

test('a scene without masks still normalises', () => {
    const scene = normalizeScene({ elements: [] }, { width: 640, height: 400 });

    assert.deepEqual(scene.masks, []);
});