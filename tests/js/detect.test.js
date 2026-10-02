import assert from 'node:assert/strict';
import test from 'node:test';

import {
    detectRegions,
    dropDuplicateRegions,
    partitionRegions,
    pendingRegions,
} from '../../resources/js/idcard/detect.js';

/**
 * Build an RGBA bitmap the detector can be pointed at.
 */
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

/**
 * A row of glyph sized blocks, i.e. what a line of text looks like once it has
 * been thresholded.
 */
function glyphLine(rect, { left, top, count, glyph = 18, tall = 14, gap = 4, colour = [20, 20, 20] }) {
    for (let index = 0; index < count; index += 1) {
        rect(left + index * (glyph + gap), top, glyph, tall, colour);
    }
}

function near(actual, expected, tolerance, label) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${label}: expected ~${expected} (+/-${tolerance}) but got ${actual}`,
    );
}

/**
 * The card from the bug report, drawn the way it is really laid out: a heading
 * band, a photo, a name, a designation and three label / value rows.
 *
 * `spacing` is the white gap between two lines, and it is the whole point of the
 * fixture: a real card sets its lines close together, which is exactly the case
 * that used to be reported as one single region - and therefore one single
 * layer - no matter how many lines it held.
 */
function acceptanceCard({ width = 1011, height = 638, spacing = 18 } = {}) {
    const rows = [
        [11, 12],
        [5, 26],
        [5, 12],
    ];

    // A run of glyph sized blocks, i.e. one printed line, and where it ended.
    const print = (rect, left, top, count, glyph, tall, gap, colour = [20, 20, 20]) => {
        for (let index = 0; index < count; index += 1) {
            rect(left + index * (glyph + gap), top, glyph, tall, colour);
        }

        return left + count * (glyph + gap);
    };

    return bitmap(width, height, ({ rect }) => {
        rect(0, 0, width, 70, [30, 64, 175]);
        print(rect, 40, 24, 18, 13, 22, 4, [255, 255, 255]);
        rect(Math.round(width * 0.7), 120, Math.round(width * 0.25), 300, [120, 90, 70]);

        for (let index = 0; index < 60; index += 1) {
            rect(40 + index * 8, Math.round(height * 0.92), 5, 34, [20, 20, 20]);
        }

        // The name, the designation, then one row per label / value pair.
        print(rect, 40, 120, 15, 20, 34, 5);
        print(rect, 40, 120 + 34 + spacing, 9, 12, 20, 4);

        let top = 120 + 34 + spacing + 20 + spacing;

        rows.forEach(([labelChars, valueChars]) => {
            const label = print(rect, 40, top, labelChars, 10, 16, 3);
            print(rect, label + 24, top, valueChars, 10, 16, 3);
            top += 16 + spacing;
        });
    });
}

test('finds a single line of text as one region', () => {
    const width = 640;
    const height = 400;
    const data = bitmap(width, height, ({ rect }) => {
        glyphLine(rect, { left: 40, top: 120, count: 10 });
    });

    const { regions } = detectRegions(data, width, height);

    assert.equal(regions.length, 1);

    const [region] = regions;

    assert.equal(region.kind, 'text');
    near(region.left, 40, 6, 'left');
    near(region.top, 120, 6, 'top');
    near(region.width, 216, 14, 'width');
    near(region.height, 14, 8, 'height');
});

test('keeps two stacked lines apart', () => {
    const width = 640;
    const height = 400;
    const data = bitmap(width, height, ({ rect }) => {
        glyphLine(rect, { left: 40, top: 120, count: 10 });
        glyphLine(rect, { left: 40, top: 170, count: 6 });
    });

    const { regions } = detectRegions(data, width, height);

    assert.equal(regions.length, 2);
    assert.ok(regions[0].top < regions[1].top, 'regions come back in reading order');
    near(regions[1].width, 6 * 22, 14, 'second line width');
});

test('ignores the coloured header and footer bands of a card', () => {
    const width = 640;
    const height = 400;
    const data = bitmap(width, height, ({ rect }) => {
        rect(0, 0, width, 70, [30, 64, 175]);
        rect(0, height - 60, width, 60, [30, 64, 175]);
        glyphLine(rect, { left: 40, top: 120, count: 10 });
    });

    const { regions } = detectRegions(data, width, height);

    assert.equal(regions.length, 1);
    assert.ok(regions[0].top > 80, 'the header band is not reported as content');
});

test('reads light text on a dark panel as content too', () => {
    const width = 640;
    const height = 400;
    const data = bitmap(width, height, ({ rect }) => {
        rect(20, 100, 300, 120, [25, 25, 25]);
        glyphLine(rect, { left: 40, top: 140, count: 8, colour: [245, 245, 245] });
    });

    const { regions } = detectRegions(data, width, height);

    assert.equal(regions.length, 1);
    assert.equal(regions[0].kind, 'graphic', 'a large filled panel counts as artwork, not text');
});

test('classifies a photo sized block as artwork', () => {
    const width = 640;
    const height = 400;
    const data = bitmap(width, height, ({ rect }) => {
        rect(60, 80, 180, 200, [120, 90, 70]);
    });

    const { regions } = detectRegions(data, width, height);

    assert.equal(regions.length, 1);
    assert.equal(regions[0].kind, 'graphic');
});

test('reports nothing for a blank card', () => {
    const width = 640;
    const height = 400;
    const data = bitmap(width, height);

    const { regions, inkRatio } = detectRegions(data, width, height);

    assert.deepEqual(regions, []);
    assert.equal(inkRatio, 0);
});

test('a photo does not swallow the labels printed beside it', () => {
    const width = 320;
    const height = 200;
    const data = bitmap(width, height, ({ rect }) => {
        // A card the way it is really laid out: an off-white panel, a coloured
        // header band with the school name against the very top edge, a picture
        // on the right, two lines of text beside it and a footer near the bottom.
        rect(0, 0, width, height, [250, 250, 246]);
        rect(0, 0, width, 30, [28, 60, 170]);
        glyphLine(rect, { left: 20, top: 4, count: 8, glyph: 6, tall: 12, gap: 4, colour: [255, 255, 255] });
        rect(200, 45, 80, 70, [120, 90, 70]);
        glyphLine(rect, { left: 20, top: 55, count: 9, glyph: 7, tall: 10, gap: 4 });
        glyphLine(rect, { left: 20, top: 80, count: 7, glyph: 7, tall: 10, gap: 4 });
        glyphLine(rect, { left: 20, top: 160, count: 12, glyph: 7, tall: 8, gap: 4 });
    });

    const { regions } = detectRegions(data, width, height);

    const heading = regions.find((region) => region.top < 30 && region.kind === 'text');
    const footer = regions.find((region) => region.top > 140 && region.kind === 'text');
    const photo = regions.find((region) => region.left > 180 && region.kind === 'graphic');

    assert.ok(heading, 'the school name in the header band is detected');
    assert.ok(footer, 'the footer line is detected');
    assert.ok(photo, 'the picture is reported as its own graphic region');
    assert.ok(regions.length >= 3, `expected several separate regions, got ${regions.length}`);

    regions
        .filter((region) => region.kind === 'text')
        .forEach((region) => {
            // No text region may stretch across the picture: that would mean the
            // picture swallowed it, or the picture swallowed everything else.
            assert.ok(
                region.left + region.width < 190,
                `a text region (${region.left}+${region.width}) must not cover the picture`,
            );
        });
});

test('refuses a region that would swallow the whole card', () => {
    const width = 300;
    const height = 300;
    const data = bitmap(width, height, ({ rect }) => {
        // One textured block covering almost the entire card: that is the
        // artwork itself, and erasing it would destroy the design instead of
        // making one piece of content editable.
        for (let y = 9; y < 191; y += 4) {
            for (let x = 9; x < 291; x += 4) {
                rect(x, y, 4, 4, (x + y) % 8 === 0 ? [240, 240, 240] : [20, 20, 20]);
            }
        }
    });

    const { regions } = detectRegions(data, width, height);

    regions.forEach((region) => {
        assert.ok(
            (region.width * region.height) / (width * height) <= 0.7,
            `a region covering ${region.width}x${region.height} would erase the whole design`,
        );
    });
});

test('survives a bitmap too small to analyse', () => {
    assert.deepEqual(detectRegions(new Uint8ClampedArray(4), 1, 1), { regions: [], inkRatio: 0 });
    assert.deepEqual(detectRegions(null, 0, 0), { regions: [], inkRatio: 0 });
});

test('routes text regions to a layer and images to the manual workflow', () => {
    const name = { left: 40, top: 100, width: 200, height: 40, kind: 'text' };
    const designation = { left: 40, top: 150, width: 120, height: 30, kind: 'text' };
    const photo = { left: 700, top: 90, width: 200, height: 240, kind: 'graphic' };
    const barcode = { left: 600, top: 480, width: 320, height: 90, kind: 'graphic' };

    // Every text region is kept as its own entry: nothing is ever merged, so a
    // card with a name and a designation ends up with two independent layers.
    assert.deepEqual(partitionRegions([name, designation, photo, barcode]), {
        text: [name, designation],
        graphic: [photo, barcode],
    });
});

test('an unclassified region counts as text so nothing is dropped', () => {
    const region = { left: 10, top: 20, width: 30, height: 40 };

    assert.deepEqual(partitionRegions([region]), { text: [region], graphic: [] });
    assert.deepEqual(partitionRegions([]), { text: [], graphic: [] });
    assert.deepEqual(partitionRegions(null), { text: [], graphic: [] });
    assert.deepEqual(partitionRegions([null, 'x']), { text: [], graphic: [] });
});

/* -------------------------------------------------------------------------
 | One region per piece of content
   ---------------------------------------------------------------------- */

test('tightly stacked lines are never reported as one region', () => {
    const width = 640;
    const height = 400;

    // Five lines of content, printed the way a card really prints them: close
    // together, all starting at the same left edge.
    const data = bitmap(width, height, ({ rect }) => {
        [70, 100, 130, 160, 190].forEach((top, index) => {
            glyphLine(rect, { left: 40, top, count: 6 + index, glyph: 14, tall: 16, gap: 4 });
        });
    });

    const { regions } = detectRegions(data, width, height);

    assert.equal(regions.length, 5, 'each of the five lines is its own region');
    assert.ok(regions.every((region) => region.kind === 'text'));

    // No region covers more than one line: every one of them stays short.
    regions.forEach((region) => {
        assert.ok(region.height <= 24, `a region of ${region.height}px is taller than a line of text`);
    });

    const tops = regions.map((region) => region.top);

    assert.equal(new Set(tops).size, 5, 'no two regions share a position');
});

test('the number of regions does not depend on how close the lines are', () => {
    const width = 1011;
    const height = 638;
    const counts = [6, 18, 34, 60].map((spacing) => {
        const { regions } = detectRegions(acceptanceCard({ spacing }), width, height);

        return partitionRegions(regions).text.length;
    });

    assert.ok(
        counts.every((count) => count === counts[0]),
        `the same card detected a different number of text regions per spacing: ${counts.join(', ')}`,
    );
});

test('a real card reports one editable region per line of content', () => {
    const width = 1011;
    const height = 638;
    const { regions } = detectRegions(acceptanceCard({ spacing: 14 }), width, height);
    const { text, graphic } = partitionRegions(regions);

    // heading band, name, designation and a label + value run for each of the
    // three rows - nine separate editable layers, not one box around the lot.
    assert.equal(text.length, 9, `expected nine lines of content, got ${JSON.stringify(text)}`);

    // The photo and the barcode are reported as artwork, never as lettering.
    assert.equal(graphic.length, 2);
    assert.ok(graphic.some((region) => region.label === 'Photo'));
    assert.ok(graphic.some((region) => region.label === 'Barcode'));
    assert.ok(!text.some((region) => region.left >= Math.round(width * 0.7)));
});

test('a barcode is artwork, so it never becomes a text layer', () => {
    const width = 1011;
    const height = 638;
    const data = bitmap(width, height, ({ rect }) => {
        // A barcode: a long run of thin bars, exactly like the printed one.
        for (let index = 0; index < 60; index += 1) {
            rect(40 + index * 8, 120, 5, 34, [20, 20, 20]);
        }

        glyphLine(rect, { left: 40, top: 220, count: 9, glyph: 18, tall: 16, gap: 4 });
    });

    const { regions } = detectRegions(data, width, height);
    const { text, graphic } = partitionRegions(regions);

    assert.equal(text.length, 1, 'only the line of lettering is editable');
    assert.equal(graphic.length, 1);
    assert.equal(graphic[0].label, 'Barcode');
    assert.ok(graphic[0].width > text[0].width, 'the barcode is wider than the line of text');
});

test('a photo and its caption stay independent from each other', () => {
    const width = 1011;
    const height = 638;
    const data = bitmap(width, height, ({ rect }) => {
        rect(700, 120, 250, 300, [120, 90, 70]);
        glyphLine(rect, { left: 40, top: 200, count: 8, glyph: 18, tall: 16, gap: 4 });
    });

    const { regions } = detectRegions(data, width, height);
    const { text, graphic } = partitionRegions(regions);

    assert.equal(graphic.length, 1, 'the photo is one region');
    assert.equal(text.length, 1, 'the caption is its own region');
    assert.ok(text[0].left < 690, 'the caption was swallowed by the photo');
});

/* -------------------------------------------------------------------------
 | Regions that still need a layer
   ---------------------------------------------------------------------- */

test('a region is only dropped when it is the very same rectangle twice', () => {
    const first = { left: 10, top: 20, width: 100, height: 20 };
    const second = { left: 10, top: 20, width: 100, height: 20 };
    const beside = { left: 120, top: 20, width: 60, height: 20 };
    const inside = { left: 20, top: 22, width: 40, height: 16 };

    assert.deepEqual(dropDuplicateRegions([first, second, beside, inside]), [first, beside, inside]);
    assert.deepEqual(dropDuplicateRegions([]), []);
    assert.deepEqual(dropDuplicateRegions(null), []);
    assert.deepEqual(dropDuplicateRegions([null, 'x']), []);
});

test('content that already has a layer is not offered again', () => {
    const regions = [
        { left: 40, top: 100, width: 300, height: 30 },
        { left: 40, top: 200, width: 300, height: 30 },
        { left: 40, top: 300, width: 300, height: 30 },
    ];

    // The first line was converted: it has a layer and its own mask.
    const scene = {
        elements: [{ id: 'el_1', type: 'text', ...regions[0] }],
        masks: [{ id: 'mk_1', ...regions[0], elementId: 'el_1' }],
    };

    assert.deepEqual(pendingRegions(regions, scene), regions.slice(1));
});

test('a layer alone is enough to recognise content that is already editable', () => {
    const regions = [{ left: 40, top: 100, width: 300, height: 30 }];

    // "Restore Original Artwork" clears the masks but keeps the layers, so a
    // second "Detect Content" must not stack a copy on top of them.
    const afterRestore = {
        elements: [{ id: 'el_1', type: 'text', ...regions[0] }],
        masks: [],
    };

    assert.deepEqual(pendingRegions(regions, afterRestore), []);
});

test('content hidden by a cover is not offered as a text layer', () => {
    const regions = [{ left: 40, top: 100, width: 300, height: 30 }];

    // A cover hides the flattened artwork on purpose and carries no text of its
    // own, so nothing underneath it is content waiting to be made editable.
    const scene = {
        elements: [{ id: 'cover_1', type: 'cover', ...regions[0] }],
        masks: [{ id: 'mk_1', ...regions[0], elementId: null }],
    };

    assert.deepEqual(pendingRegions(regions, scene), []);
    assert.deepEqual(pendingRegions(regions, null), regions);
    assert.deepEqual(pendingRegions(regions, { elements: [], masks: [] }), regions);
});

test('every line of a card still gets its own layer when detection runs twice', () => {
    const width = 1011;
    const height = 638;
    const { regions } = detectRegions(acceptanceCard({ spacing: 14 }), width, height);
    const { text } = partitionRegions(regions);
    const scene = { elements: [], masks: [] };
    const firstRun = pendingRegions(text, scene);

    // What the builder does with a run: one layer and one owned mask per region.
    firstRun.forEach((region, index) => {
        const id = `el_${index + 1}`;

        scene.elements.push({ id, type: 'text', ...region });
        scene.masks.push({ id: `mk_${index + 1}`, ...region, elementId: id });
    });

    assert.equal(scene.elements.length, 9);
    assert.deepEqual(pendingRegions(text, scene), [], 'the second run must add no text layers');

    // The photo and the barcode are still waiting for a file from the user, so
    // their guides stay on screen instead of turning into empty layers.
    assert.deepEqual(
        pendingRegions(regions, scene).map((region) => region.label).sort(),
        ['Barcode', 'Photo'],
    );
});
