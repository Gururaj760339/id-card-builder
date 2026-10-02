/**
 * Content region detection for flattened ID card designs.
 *
 * Finds where the visible content of an uploaded JPG/PNG actually is, so the
 * builder can turn the flattened lettering of a card into real editable layers
 * instead of asking the user to re-type everything by hand.
 *
 * The approach is deliberately dependency free - no OCR engine, no WASM, no
 * network request. It is classical image analysis on a plain Canvas 2D:
 *
 *   1. compare every pixel with the local average brightness to get an "ink"
 *      mask that works for dark-on-light *and* light-on-dark text,
 *   2. label the connected components of that mask (letters, digits, words),
 *   3. group the components into text lines by vertical overlap and spacing,
 *   4. group stacked lines into blocks, purely to recognise a picture,
 *   5. report **one rectangle per text line** - never per block - in card
 *      coordinates, and one rectangle per picture.
 *
 * A detected rectangle is a *region*, not a guess about the words inside it: the
 * builder erases that rectangle from the bitmap and drops an editable text layer
 * of the right size and colour on top, which is what makes the existing design
 * genuinely editable without inventing text.
 *
 * Step 5 is the whole point of this module and the reason it is written the way
 * it is: the builder turns *one region into exactly one editable layer*, so a
 * block of five stacked lines reported as one rectangle becomes one layer that
 * covers all five lines - unselectable, unretypeable and undeletable on their
 * own. Grouping lines therefore only ever describes artwork; it never decides
 * how many text regions a card has.
 *
 * {@link detectRegions} is a pure function over an RGBA buffer so it can be unit
 * tested without a browser; {@link detectDesignRegions} is the browser wrapper
 * that downsamples the card and converts the result back to design pixels.
 */

/** Longest edge used while analysing, in pixels. */
const WORK_SIZE = 640;

/** Ink has to differ from its neighbourhood by at least this much. */
const INK_THRESHOLD = 24;

/** Ink further than this many steps from black/white is background. */
const MAX_INK_DARK = 250;

/** Discard specks smaller than this many pixels at working scale. */
const MIN_COMPONENT_AREA = 6;

/** Regions taller than this share of the card are treated as artwork. */
const GRAPHIC_HEIGHT_RATIO = 0.16;

/** Never report more regions than this. */
const MAX_REGIONS = 80;

/**
 * A region covering more than this share of the card is the card itself - the
 * frame, a filled background or one photo that happens to touch every edge - not
 * a block of content.
 *
 * Such a rectangle is refused on purpose: erasing it would flatten the whole
 * design instead of making one piece of content editable, which is exactly what
 * the masking is supposed to avoid. The user still has the manual fallback
 * ("Add Editable Text") for anything the detector cannot separate.
 */
const MAX_REGION_AREA_RATIO = 0.7;

/**
 * A single ink run that fills its own box and is at least this share of the card
 * in both directions is a picture - a photo, a logo, a QR code - not lettering.
 *
 * The size floor is what keeps it honest: a line of text is never one solid
 * block, and a lone narrow glyph ("I", a hyphen, a bullet) never reaches this
 * size, so those still come back as text.
 */
const SOLID_ARTWORK_RATIO = 0.08;

/** A barcode is a long run of thin bars; this is its minimum length on the card. */
const CODE_LENGTH_RATIO = 0.12;

/** At least this many thin bars have to sit on one line before it is a code. */
const MIN_CODE_BARS = 5;

/** ...and they have to be the majority of what is on that line. */
const CODE_BAR_SHARE = 0.6;

/* -------------------------------------------------------------------------
 | Pure analysis
   ---------------------------------------------------------------------- */

/**
 * Luminance of every pixel.
 */
function toLuminance(data, width, height) {
    const luminance = new Float32Array(width * height);

    for (let index = 0; index < luminance.length; index += 1) {
        const offset = index * 4;

        luminance[index] = (data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114);
    }

    return luminance;
}

/**
 * Summed area table, used to read a box average in constant time.
 */
function integralImage(luminance, width, height) {
    const sums = new Float64Array((width + 1) * (height + 1));

    for (let y = 0; y < height; y += 1) {
        let rowSum = 0;

        for (let x = 0; x < width; x += 1) {
            rowSum += luminance[y * width + x];
            sums[(y + 1) * (width + 1) + (x + 1)] = sums[y * (width + 1) + (x + 1)] + rowSum;
        }
    }

    return sums;
}

/**
 * Average brightness inside a box, clamped to the image.
 */
function boxMean(sums, width, height, x0, y0, x1, y1) {
    const left = Math.max(0, x0);
    const top = Math.max(0, y0);
    const right = Math.min(width, x1);
    const bottom = Math.min(height, y1);

    if (right <= left || bottom <= top) {
        return 0;
    }

    const stride = width + 1;
    const area = (right - left) * (bottom - top);
    const total = sums[bottom * stride + right] - sums[top * stride + right]
        - sums[bottom * stride + left] + sums[top * stride + left];

    return total / area;
}

/**
 * Binary ink map: pixels that stand out from their own neighbourhood.
 */
function inkMap(luminance, width, height, threshold) {
    const sums = integralImage(luminance, width, height);
    const radius = Math.max(2, Math.round(Math.min(width, height) / 55));
    const ink = new Uint8Array(width * height);

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = y * width + x;
            const value = luminance[index];

            if (value > MAX_INK_DARK) {
                continue;
            }

            const mean = boxMean(sums, width, height, x - radius, y - radius, x + radius + 1, y + radius + 1);

            if (Math.abs(value - mean) >= threshold) {
                ink[index] = 1;
            }
        }
    }

    return ink;
}

/**
 * Join horizontal neighbours so broken strokes and the dot of an "i" survive.
 */
function dilateHorizontal(ink, width, height) {
    const out = new Uint8Array(ink.length);

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = y * width + x;

            out[index] = ink[index]
                || (x > 0 && ink[index - 1])
                || (x + 1 < width && ink[index + 1])
                ? 1
                : 0;
        }
    }

    return out;
}

/**
 * Label 8-connected components with an explicit stack (never recurses).
 */
function connectedComponents(ink, width, height) {
    const labels = new Int32Array(ink.length).fill(-1);
    const stack = new Int32Array(ink.length);
    const boxes = [];
    let current = 0;

    for (let start = 0; start < ink.length; start += 1) {
        if (!ink[start] || labels[start] !== -1) {
            continue;
        }

        let top = 0;
        let area = 0;
        let minX = width;
        let minY = height;
        let maxX = -1;
        let maxY = -1;

        stack[top] = start;
        top += 1;
        labels[start] = current;

        while (top > 0) {
            top -= 1;
            const index = stack[top];
            const x = index % width;
            const y = (index - x) / width;

            area += 1;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);

            for (let dy = -1; dy <= 1; dy += 1) {
                for (let dx = -1; dx <= 1; dx += 1) {
                    if (dx === 0 && dy === 0) {
                        continue;
                    }

                    const nx = x + dx;
                    const ny = y + dy;

                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
                        continue;
                    }

                    const neighbour = ny * width + nx;

                    if (ink[neighbour] && labels[neighbour] === -1) {
                        labels[neighbour] = current;
                        stack[top] = neighbour;
                        top += 1;
                    }
                }
            }
        }

        boxes.push({
            left: minX,
            top: minY,
            width: maxX - minX + 1,
            height: maxY - minY + 1,
            area,
        });

        current += 1;
    }

    return boxes;
}

/**
 * Drop specks, hairlines and the card frame, keep anything text shaped.
 */
function keepComponents(boxes, width, height) {
    const minHeight = Math.max(3, Math.round(height * 0.006));
    const maxHeight = Math.round(height * 0.75);

    return boxes.filter((box) => {
        if (box.area < MIN_COMPONENT_AREA) {
            return false;
        }

        if (box.height < minHeight || box.height > maxHeight) {
            return false;
        }

        if (box.width < 1 || box.width > width * 0.98) {
            return false;
        }

        // A frame or a divider rule touches (almost) every edge.
        if (box.width > width * 0.92 && box.left <= 1 && box.left + box.width >= width - 2) {
            return false;
        }

        if (box.height > height * 0.5 && (box.left <= 1 || box.left + box.width >= width - 1)) {
            return false;
        }

        return true;
    });
}

/**
 * Union of two boxes.
 */
function mergeBoxes(a, b) {
    const left = Math.min(a.left, b.left);
    const top = Math.min(a.top, b.top);
    const right = Math.max(a.left + a.width, b.left + b.width);
    const bottom = Math.max(a.top + a.height, b.top + b.height);

    return {
        left,
        top,
        width: right - left,
        height: bottom - top,
        area: a.area + b.area,
    };
}

/**
 * Vertical overlap of two boxes as a share of the shorter one.
 */
function verticalOverlap(a, b) {
    const top = Math.max(a.top, b.top);
    const bottom = Math.min(a.top + a.height, b.top + b.height);

    if (bottom <= top) {
        return 0;
    }

    return (bottom - top) / Math.max(1, Math.min(a.height, b.height));
}

/**
 * Horizontal overlap as a share of the narrower box.
 */
function horizontalOverlap(a, b) {
    const left = Math.max(a.left, b.left);
    const right = Math.min(a.left + a.width, b.left + b.width);

    if (right <= left) {
        return 0;
    }

    return (right - left) / Math.max(1, Math.min(a.width, b.width));
}

/**
 * Combine neighbouring components into text lines.
 *
 * The tolerance is the height of the *smaller* box, never the larger one: a
 * photo or a logo is far taller than a line of text, and scaling the gap by its
 * height made the picture swallow every label printed beside it - which then
 * chained the whole card into a single "text block".
 *
 * Every line keeps the component boxes it was built from (`parts`). They are the
 * only evidence available for telling a filled picture or a barcode from
 * lettering without reading a single character, and {@link classifyLine} needs
 * them, so they travel with the line instead of being recomputed later.
 */
function groupLines(boxes) {
    const lines = [];

    [...boxes]
        .sort((a, b) => (a.top + a.height / 2) - (b.top + b.height / 2) || a.left - b.left)
        .forEach((box) => {
            const centre = box.top + box.height / 2;
            const line = lines.find((candidate) => {
                const otherCentre = candidate.top + candidate.height / 2;
                const reference = Math.max(1, Math.min(candidate.height, box.height));

                if (Math.abs(centre - otherCentre) > reference * 0.8) {
                    return false;
                }

                const gap = box.left > candidate.left + candidate.width
                    ? box.left - (candidate.left + candidate.width)
                    : candidate.left - (box.left + box.width);

                return verticalOverlap(candidate, box) > 0.35 && gap < reference * 1.1;
            });

            if (line) {
                Object.assign(line, mergeBoxes(line, box));
                line.parts.push(box);

                return;
            }

            lines.push({ ...box, parts: [box] });
        });

    return lines;
}

/**
 * Combine stacked lines into blocks.
 *
 * A block is *not* a region: it only exists so a picture can be recognised as
 * one piece of content even when its ink falls into several lines. Each block
 * remembers the lines it was built from (`lines`), so the reporting step can put
 * every one of those lines back as its own region instead of one box around the
 * lot of them.
 *
 * As in {@link groupLines} the tolerance follows the shorter of the two boxes,
 * so a tall photo or logo never drags the labels beside it into one block.
 */
function groupBlocks(lines) {
    const blocks = [];

    [...lines]
        .sort((a, b) => a.top - b.top || a.left - b.left)
        .forEach((line) => {
            const block = blocks.find((candidate) => {
                const gap = line.top > candidate.top + candidate.height
                    ? line.top - (candidate.top + candidate.height)
                    : candidate.top - (line.top + line.height);

                const reference = Math.max(1, Math.min(candidate.height, line.height));

                return gap >= 0
                    && gap < reference * 0.9
                    && horizontalOverlap(candidate, line) > 0.2;
            });

            if (block) {
                Object.assign(block, mergeBoxes(block, line));
                block.lines.push(line);

                return;
            }

            blocks.push({ ...line, lines: [line] });
        });

    return blocks;
}

/* -------------------------------------------------------------------------
 | Region shape
   ---------------------------------------------------------------------- */

/**
 * The thin vertical bars of a barcode, QR code or rule.
 *
 * A bar is much taller than it is wide, which is true of a barcode stroke and of
 * almost no letter: a glyph is as wide as it is tall or wider. So counting them
 * on a line separates a code from a line of text without reading any of it.
 */
function barsOn(line) {
    return (line.parts || []).filter((box) => (
        box.height >= 4
        && box.width <= Math.max(2, box.height * 0.5)
    ));
}

/**
 * One ink run that fills its whole box: a photo, a panel, a logo, a solid rule.
 */
function isSolidBlock(line, scale) {
    const parts = line.parts || [];

    if (parts.length !== 1) {
        return false;
    }

    const [box] = parts;
    const solid = box.area >= box.width * box.height * 0.92;

    return solid && Math.min(box.width, box.height) >= scale * SOLID_ARTWORK_RATIO;
}

/**
 * A long run of thin bars: a barcode or a QR code.
 */
function isCode(line, scale) {
    if (Math.max(line.width, line.height) < scale * CODE_LENGTH_RATIO) {
        return false;
    }

    const bars = barsOn(line);

    return bars.length >= MIN_CODE_BARS
        && bars.length >= (line.parts || []).length * CODE_BAR_SHARE;
}

/**
 * Artwork (a photo, a logo, a barcode) or lettering?
 *
 * The decision is made per line, never per block: a block of five stacked lines
 * of a name, a designation, an ID, an e-mail and a phone is *tall*, and testing
 * the accumulated block is what used to hand that whole block to the artwork
 * branch - reporting it as one picture and turning none of it editable.
 */
function classifyLine(line, scale) {
    if (line.height > scale * GRAPHIC_HEIGHT_RATIO) {
        return 'graphic';
    }

    return isSolidBlock(line, scale) || isCode(line, scale) ? 'graphic' : 'text';
}

/**
 * Grow a raw box by a hair, so the mask that erases the flattened original also
 * covers the antialiasing around the ink, and clamp it to the card.
 */
function padRegion(box, width, height) {
    const pad = Math.max(1, Math.round(box.height * 0.16));
    const left = Math.max(0, box.left - pad);
    const top = Math.max(0, box.top - pad);

    return {
        left,
        top,
        width: Math.min(width - left, box.width + pad * 2),
        height: Math.min(height - top, box.height + pad * 2),
    };
}

/**
 * A readable name for a picture region, so the Layers panel can tell a photo
 * from a barcode without the user having to work it out from a dashed box.
 *
 * There is no OCR here, so this is deliberately coarse: a run of bars is a
 * barcode, a big filled area is a photo, anything smaller is just an image.
 */
function artworkLabel(lines, scale, box) {
    if (lines.some((line) => isCode(line, scale))) {
        return 'Barcode';
    }

    return Math.min(box.width, box.height) >= scale * 0.2 ? 'Photo' : 'Image';
}

/**
 * Turn one block into the regions it really stands for.
 *
 * Every line of lettering becomes its own region - one region, one editable
 * layer - and the artwork lines (if any) are unioned back into a single region,
 * because a photo, a logo or a barcode is one piece of content that must stay
 * independent from the text around it rather than a stack of strips.
 */
function blockRegions(block, scale, width, height) {
    const artwork = [];
    const text = [];

    (block.lines || [block]).forEach((line) => {
        (classifyLine(line, scale) === 'graphic' ? artwork : text).push(line);
    });

    const regions = text.map((line) => ({ ...padRegion(line, width, height), kind: 'text' }));

    if (artwork.length) {
        const box = artwork.reduce((union, line) => mergeBoxes(union, line));

        regions.push({
            ...padRegion(box, width, height),
            kind: 'graphic',
            label: artworkLabel(artwork, scale, box),
        });
    }

    return regions;
}

/**
 * Find every content region of an RGBA bitmap.
 *
 * @param {Uint8ClampedArray|number[]} data RGBA pixels, row major
 * @param {number} width bitmap width
 * @param {number} height bitmap height
 * @param {{threshold?: number}} [options]
 * @returns {{regions: Array<{left:number, top:number, width:number, height:number, kind:string}>, inkRatio:number}}
 */
export function detectRegions(data, width, height, options = {}) {
    const empty = { regions: [], inkRatio: 0 };

    if (!data || width < 4 || height < 4) {
        return empty;
    }

    const luminance = toLuminance(data, width, height);
    const ink = dilateHorizontal(inkMap(luminance, width, height, options.threshold ?? INK_THRESHOLD), width, height);

    let inkCount = 0;

    for (let index = 0; index < ink.length; index += 1) {
        inkCount += ink[index];
    }

    const inkRatio = inkCount / ink.length;

    // Either an empty card or a photo filling the whole card: nothing to split.
    if (inkRatio < 0.0008 || inkRatio > 0.6) {
        return { regions: [], inkRatio };
    }

    const boxes = keepComponents(connectedComponents(ink, width, height), width, height);

    if (!boxes.length) {
        return { regions: [], inkRatio };
    }

    const blocks = groupBlocks(groupLines(boxes));
    const scale = Math.min(width, height);
    const cardArea = width * height;

    // One region per line of lettering, one per picture: a block is expanded
    // back into the separate regions it was grouped from, never reported whole.
    const regions = blocks
        .flatMap((block) => blockRegions(block, scale, width, height))
        .filter((region) => region.width >= 3 && region.height >= 3)
        .filter((region) => (region.width * region.height) / cardArea <= MAX_REGION_AREA_RATIO)
        .sort((a, b) => a.top - b.top || a.left - b.left)
        .slice(0, MAX_REGIONS);

    return { regions, inkRatio };
}

/* -------------------------------------------------------------------------
 | Browser entry point
  ---------------------------------------------------------------------- */

/**
 * Analyse an uploaded card design and report where its content lives.
 *
 * The image is analysed at a reduced size for speed, then every rectangle is
 * converted back into card ("design") coordinates, so the numbers can be stored
 * in the scene and stay correct at any editor zoom level.
 *
 * @param {HTMLImageElement} image the untouched uploaded design
 * @param {{width:number, height:number}} card the card size in design pixels
 * @returns {Array<{left:number, top:number, width:number, height:number, kind:string, fontSize:number}>}
 */
export function detectDesignRegions(image, card) {
    // Never measure a bitmap that is missing or has not finished decoding: every
    // rectangle below is derived from these four numbers.
    if (!image || !(Number(image.naturalWidth) > 0) || !(Number(image.naturalHeight) > 0)) {
        return [];
    }

    const cardWidth = Math.max(1, Math.round(Number(card?.width) || image.naturalWidth));
    const cardHeight = Math.max(1, Math.round(Number(card?.height) || image.naturalHeight));
    const scale = Math.min(cardWidth, cardHeight) / WORK_SIZE;
    const workWidth = Math.max(8, Math.round(cardWidth / scale));
    const workHeight = Math.max(8, Math.round(cardHeight / scale));
    const fit = Math.min(cardWidth / image.naturalWidth, cardHeight / image.naturalHeight);
    const offsetX = (cardWidth - image.naturalWidth * fit) / 2;
    const offsetY = (cardHeight - image.naturalHeight * fit) / 2;

    const canvas = document.createElement('canvas');

    canvas.width = workWidth;
    canvas.height = workHeight;

    const context = canvas.getContext('2d', { willReadFrequently: true });

    if (!context) {
        return [];
    }

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, workWidth, workHeight);
    context.drawImage(
        image,
        offsetX,
        offsetY,
        image.naturalWidth * fit,
        image.naturalHeight * fit,
        0,
        0,
        workWidth,
        workHeight,
    );

    const bitmap = context.getImageData(0, 0, workWidth, workHeight);
    const { regions } = detectRegions(bitmap.data, workWidth, workHeight);

    return regions.map((region) => {
        const left = round2((region.left / workWidth) * cardWidth);
        const top = round2((region.top / workHeight) * cardHeight);
        const boxWidth = round2((region.width / workWidth) * cardWidth);
        const boxHeight = round2((region.height / workHeight) * cardHeight);

        return {
            left,
            top,
            width: boxWidth,
            height: boxHeight,
            kind: region.kind,
            label: region.label,
            // Cap height of most fonts is ~0.72em, so the ink height gives a
            // sensible starting point that the user can still change.
            fontSize: Math.max(6, Math.min(160, Math.round(boxHeight / (region.kind === 'graphic' ? 1 : 0.78)))),
        };
    });
}

function round2(value) {
    return Math.round(value * 100) / 100;
}

/* -------------------------------------------------------------------------
 | Region routing
   ---------------------------------------------------------------------- */

/**
 * Split detected rectangles into the ones that can become a text layer straight
 * away and the ones that need a picture from the user first.
 *
 * Text is pixels the builder can rebuild on its own: mask the rectangle and put
 * an editable text layer of the measured size and ink colour on top of it. A
 * photo, logo, barcode or signature cannot be invented, so those stay as dashed
 * guides and are only replaced once the user picks a file - erasing them up front
 * would destroy the original artwork with nothing to put in its place.
 *
 * @param {Array<{kind?: string}>} regions detected rectangles
 * @returns {{text: Array<object>, graphic: Array<object>}}
 */
export function partitionRegions(regions) {
    const text = [];
    const graphic = [];

    (Array.isArray(regions) ? regions : []).forEach((region) => {
        if (!region || typeof region !== 'object') {
            return;
        }

        (region.kind === 'graphic' ? graphic : text).push(region);
    });

    return { text, graphic };
}

/* -------------------------------------------------------------------------
 | Regions that still need a layer
   ---------------------------------------------------------------------- */

/** How much of `inner` sits inside `outer`, as a share of `inner`. */
function overlapRatio(inner, outer) {
    const width = Math.max(
        0,
        Math.min(inner.left + inner.width, outer.left + outer.width) - Math.max(inner.left, outer.left),
    );
    const height = Math.max(
        0,
        Math.min(inner.top + inner.height, outer.top + outer.height) - Math.max(inner.top, outer.top),
    );

    if (width <= 0 || height <= 0) {
        return 0;
    }

    return (width * height) / Math.max(1, inner.width * inner.height);
}

/** The middle of a region, in card coordinates. */
function centreOf(box) {
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/** True when `point` falls inside `box`. */
function contains(box, point) {
    return point.x >= box.left
        && point.x <= box.left + box.width
        && point.y >= box.top
        && point.y <= box.top + box.height;
}

/**
 * Drop rectangles that describe the very same piece of content twice.
 *
 * Only a genuinely co-located rectangle is dropped. An earlier version threw a
 * region away as soon as a *bigger* neighbour covered more than half of it, which
 * quietly deleted real content: a label printed inside a photo, or a value whose
 * padded box grazed the line above it, simply never became an editable layer.
 * Detected regions are content, not a set to be minimised.
 *
 * @param {Array<object>} regions detected rectangles
 * @returns {Array<object>} the same rectangles, minus exact duplicates
 */
export function dropDuplicateRegions(regions) {
    const kept = [];

    (Array.isArray(regions) ? regions : []).forEach((region) => {
        if (!region || typeof region !== 'object') {
            return;
        }

        const duplicate = kept.some((other) => (
            Math.abs(other.left - region.left) <= 2
            && Math.abs(other.top - region.top) <= 2
            && Math.abs(other.width - region.width) <= 2
            && Math.abs(other.height - region.height) <= 2
        ));

        if (!duplicate) {
            kept.push(region);
        }
    });

    return kept;
}

/** The layers that could already own the content of a region. */
const CONTENT_TYPES = ['text', 'dynamic_text', 'terms', 'image', 'qrcode', 'barcode'];

/**
 * The detected regions that still need their own layer.
 *
 * Clicking "Detect Content" twice, or re-opening a saved template, must not
 * stack a second layer over content that is already editable. A region counts as
 * done when
 *
 *   - the middle of it sits inside an erased rectangle (its flattened original
 *     has been masked out already), or
 *   - a text / image layer already covers it (it was converted before, for
 *     instance before "Restore Original Artwork" put the artwork back).
 *
 * The check is per region and never looks at the other regions, so a card with
 * ten lines still gets ten layers on the first run and nothing at all on the
 * second.
 *
 * @param {Array<object>} regions detected rectangles
 * @param {{masks?: Array<object>, elements?: Array<object>}} scene the side being edited
 * @returns {Array<object>} the regions that have no layer yet
 */
export function pendingRegions(regions, scene = {}) {
    const masks = (Array.isArray(scene?.masks) ? scene.masks : []).filter(Boolean);
    const layers = (Array.isArray(scene?.elements) ? scene.elements : [])
        .filter((element) => element && CONTENT_TYPES.includes(element.type));

    return (Array.isArray(regions) ? regions : []).filter((region) => {
        if (!region || typeof region !== 'object') {
            return false;
        }

        const point = centreOf(region);

        if (masks.some((mask) => contains(mask, point))) {
            return false;
        }

        return !layers.some((layer) => contains(layer, point) && overlapRatio(region, layer) >= 0.55);
    });
}
