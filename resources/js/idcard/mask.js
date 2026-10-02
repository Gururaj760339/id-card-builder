/**
 * Region masking for flattened ID card designs.
 *
 * A JPG/PNG card is one flattened bitmap: its logo, name, designation, e-mail,
 * phone number and barcode are painted pixels, not objects. Simply drawing an
 * editable text layer on top therefore leaves the original lettering visible
 * underneath, so editing produces two copies and deleting makes the original
 * reappear.
 *
 * This module produces a *masked copy of the original bitmap*: every region the
 * user has marked is erased and inpainted from the pixels that surround it, so
 * the rest of the artwork stays byte for byte identical while the flattened
 * content in that rectangle is gone for good. The editable layers are then
 * drawn on top of the masked copy.
 *
 * Masks are deliberately independent from the layers they belong to:
 *  - moving a layer leaves the hole at the original position (no duplicates),
 *  - deleting a layer leaves the hole (the original never comes back),
 *  - both survive a save / reload because the masks are part of the scene.
 *
 * Everything here runs on a plain Canvas 2D - no extra dependency, no server
 * round trip - and works in card ("design") coordinates, so zooming the editor
 * never changes the stored geometry.
 */

/** Refuse to touch absurd pixel counts instead of exhausting browser memory. */
const MAX_INPAINT_PIXELS = 24_000_000;

/** Width of the strip sampled above / below / left / right of a region. */
const SAMPLE_BAND = 4;

/**
 * Read one pixel from an ImageData buffer.
 */
function pixelAt(data, width, x, y) {
    const offset = (y * width + x) * 4;

    return [data[offset], data[offset + 1], data[offset + 2]];
}

/**
 * Average colour of a horizontal strip, used as the "clean" colour above or
 * below a masked region.
 */
function averageRow(data, width, y, fromX, toX) {
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;

    for (let x = Math.max(0, fromX); x < Math.min(width, toX); x += 1) {
        const [pr, pg, pb] = pixelAt(data, width, x, y);

        r += pr;
        g += pg;
        b += pb;
        count += 1;
    }

    if (!count) {
        return null;
    }

    return [r / count, g / count, b / count];
}

/**
 * Average colour of a vertical strip, used as the clean colour left or right of a
 * masked region.
 */
function averageColumn(data, width, height, x, fromY, toY) {
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;

    for (let y = Math.max(0, fromY); y < Math.min(height, toY); y += 1) {
        const [pr, pg, pb] = pixelAt(data, width, x, y);

        r += pr;
        g += pg;
        b += pb;
        count += 1;
    }

    if (!count) {
        return null;
    }

    return [r / count, g / count, b / count];
}

/**
 * Whole image average, the last resort when a region touches every edge.
 */
function averageImage(data, width, height) {
    let r = 0;
    let g = 0;
    let b = 0;
    const step = Math.max(1, Math.floor((width * height) / 20000));
    let count = 0;

    for (let index = 0; index < width * height; index += step) {
        const offset = index * 4;

        r += data[offset];
        g += data[offset + 1];
        b += data[offset + 2];
        count += 1;
    }

    if (!count) {
        return [255, 255, 255];
    }

    return [r / count, g / count, b / count];
}

/**
 * Fill a rectangle with a vertical blend between the clean colour sampled just
 * above it and the clean colour sampled just below it.
 *
 * This is what keeps gradients and coloured panels intact while the lettering
 * inside the rectangle disappears.
 */
function inpaintVertically(data, width, height, rect) {
    const top = Math.max(0, Math.floor(rect.top));
    const bottom = Math.min(height, Math.ceil(rect.top + rect.height));
    const left = Math.max(0, Math.floor(rect.left));
    const right = Math.min(width, Math.ceil(rect.left + rect.width));

    if (right - left < 2 || bottom - top < 2 || top <= 0 || bottom >= height) {
        return false;
    }

    const span = bottom - top;
    const above = [];
    const below = [];

    for (let x = left; x < right; x += 1) {
        let topColour = null;
        let bottomColour = null;

        for (let band = 1; band <= SAMPLE_BAND; band += 1) {
            topColour = topColour || averageRow(data, width, top - band, left, right);
            bottomColour = bottomColour || averageRow(data, width, bottom - 1 + band, left, right);

            if (topColour && bottomColour) {
                break;
            }
        }

        if (!topColour) {
            topColour = averageRow(data, width, Math.max(0, top - 1), left, right);
        }

        if (!bottomColour) {
            bottomColour = averageRow(data, width, Math.min(height - 1, bottom), left, right);
        }

        above.push(topColour || [255, 255, 255]);
        below.push(bottomColour || [255, 255, 255]);
    }

    for (let y = top; y < bottom; y += 1) {
        const ratio = (y - top + 1) / (span + 1);

        for (let x = left; x < right; x += 1) {
            const from = above[x - left];
            const to = below[x - left];
            const offset = (y * width + x) * 4;

            data[offset] = from[0] + (to[0] - from[0]) * ratio;
            data[offset + 1] = from[1] + (to[1] - from[1]) * ratio;
            data[offset + 2] = from[2] + (to[2] - from[2]) * ratio;
        }
    }

    return true;
}

/**
 * Horizontal counterpart of {@link inpaintVertically}, for regions that touch
 * the top or bottom edge of the card.
 */
function inpaintHorizontally(data, width, height, rect) {
    const top = Math.max(0, Math.floor(rect.top));
    const bottom = Math.min(height, Math.ceil(rect.top + rect.height));
    const left = Math.max(0, Math.floor(rect.left));
    const right = Math.min(width, Math.ceil(rect.left + rect.width));

    if (right - left < 2 || left <= 0 || right >= width) {
        return false;
    }

    const span = right - left;

    for (let x = left; x < right; x += 1) {
        const ratio = (x - left + 1) / (span + 1);
        const from = averageColumn(data, width, height, left - 1, top, bottom) || [255, 255, 255];
        const to = averageColumn(data, width, height, right, top, bottom) || [255, 255, 255];

        for (let y = top; y < bottom; y += 1) {
            const offset = (y * width + x) * 4;

            data[offset] = from[0] + (to[0] - from[0]) * ratio;
            data[offset + 1] = from[1] + (to[1] - from[1]) * ratio;
            data[offset + 2] = from[2] + (to[2] - from[2]) * ratio;
        }
    }

    return true;
}

/**
 * Erase a region by flooding it with one colour.
 */
function inpaintFlat(data, width, height, rect) {
    const top = Math.max(0, Math.floor(rect.top));
    const bottom = Math.min(height, Math.ceil(rect.top + rect.height));
    const left = Math.max(0, Math.floor(rect.left));
    const right = Math.min(width, Math.ceil(rect.left + rect.width));
    const [r, g, b] = averageImage(data, width, height);

    for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
            const offset = (y * width + x) * 4;

            data[offset] = r;
            data[offset + 1] = g;
            data[offset + 2] = b;
        }
    }
}

/**
 * Clamp every mask to the card and drop the degenerate ones.
 */
function usableRects(masks, width, height) {
    return (masks || [])
        .map((mask) => {
            const left = Number(mask?.left);
            const top = Number(mask?.top);
            const boxWidth = Number(mask?.width);
            const boxHeight = Number(mask?.height);

            if (![left, top, boxWidth, boxHeight].every(Number.isFinite)) {
                return null;
            }

            if (boxWidth < 1 || boxHeight < 1) {
                return null;
            }

            const x = Math.max(0, Math.min(width - 1, left));
            const y = Math.max(0, Math.min(height - 1, top));

            return {
                left: x,
                top: y,
                width: Math.min(boxWidth, width - x),
                height: Math.min(boxHeight, height - y),
            };
        })
        .filter((rect) => rect && rect.width >= 1 && rect.height >= 1);
}

/**
 * True when a bitmap really decoded and can be measured.
 *
 * Every helper here reads `naturalWidth` / `naturalHeight` to letterbox the
 * design, so an image that is missing, empty or only half decoded would turn a
 * division by zero into a NaN box - the source of "cannot read properties of
 * undefined (reading 'width')" crashes further down the line.
 */
function isDecoded(image) {
    return Boolean(image)
        && Number(image.naturalWidth) > 0
        && Number(image.naturalHeight) > 0;
}

/**
 * Draw the pristine card design into a canvas that is exactly the card size.
 *
 * The design is letter-boxed with the very same "contain" maths the editor uses
 * for the background, so a mask expressed in card coordinates lands precisely on
 * the pixels the user saw on screen.
 */
function drawDesign(target, image, card) {
    if (!isDecoded(image)) {
        return false;
    }

    const width = target.width;
    const height = target.height;
    const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);

    target.fillStyle = '#ffffff';
    target.fillRect(0, 0, width, height);

    target.drawImage(
        image,
        (width - image.naturalWidth * scale) / 2,
        (height - image.naturalHeight * scale) / 2,
        image.naturalWidth * scale,
        image.naturalHeight * scale,
    );

    return true;
}

/**
 * Create the drawing surface used by the masking helpers.
 *
 * Kept behind a factory so the pixel maths can be exercised in a plain Node test
 * with a stub context, without pulling a canvas implementation into the bundle.
 */
function createSurface(width, height, factory) {
    const canvas = (factory || (() => document.createElement('canvas')))();

    canvas.width = width;
    canvas.height = height;

    return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
}

/**
 * Produce the masked background bitmap for one side of the card.
 *
 * @param {HTMLImageElement} image the untouched uploaded design
 * @param {{width: number, height: number}} card the card size in design pixels
 * @param {Array<{left:number, top:number, width:number, height:number}>} masks regions to erase
 * @param {(() => object)|null} factory optional canvas factory, used by the tests
 * @returns {HTMLCanvasElement|null} a card sized canvas, or null when nothing can be done
 */
export function renderMaskedBackground(image, card, masks = [], factory = null) {
    if (!isDecoded(image)) {
        return null;
    }

    const width = Math.max(1, Math.round(card?.width || image.naturalWidth));
    const height = Math.max(1, Math.round(card?.height || image.naturalHeight));
    const { canvas, context } = createSurface(width, height, factory);

    if (!context) {
        return null;
    }

    drawDesign(context, image, { width, height });

    const rects = usableRects(masks, width, height);

    if (!rects.length) {
        return canvas;
    }

    if (width * height > MAX_INPAINT_PIXELS) {
        rects.forEach((rect) => {
            context.fillStyle = '#ffffff';
            context.fillRect(rect.left, rect.top, rect.width, rect.height);
        });

        return canvas;
    }

    const bitmap = context.getImageData(0, 0, width, height);

    rects.forEach((rect) => {
        if (inpaintVertically(bitmap.data, width, height, rect)) {
            return;
        }

        if (inpaintHorizontally(bitmap.data, width, height, rect)) {
            return;
        }

        inpaintFlat(bitmap.data, width, height, rect);
    });

    context.putImageData(bitmap, 0, 0);

    return canvas;
}

/**
 * Sample the colour of the lettering inside a region so a generated editable
 * layer can start out looking like the original.
 *
 * The most frequent colour of the region is the paper / panel behind the text,
 * so the most frequent *other* colour is the ink.
 *
 * @returns {{fill: string, background: string, inkRatio: number}}
 */
export function sampleRegionColours(image, card, region, buckets = 24, factory = null) {
    const fallback = { fill: '#111111', background: '#ffffff', inkRatio: 0 };

    if (!isDecoded(image)) {
        return fallback;
    }

    const width = Math.max(1, Math.round(card?.width || image.naturalWidth));
    const height = Math.max(1, Math.round(card?.height || image.naturalHeight));
    const { context } = createSurface(width, height, factory);

    if (!context) {
        return fallback;
    }

    drawDesign(context, image, { width, height });

    const left = Math.max(0, Math.floor(region.left));
    const top = Math.max(0, Math.floor(region.top));
    const right = Math.min(width, Math.ceil(region.left + region.width));
    const bottom = Math.min(height, Math.ceil(region.top + region.height));

    if (right - left < 1 || bottom - top < 1) {
        return fallback;
    }

    const bitmap = context.getImageData(left, top, right - left, bottom - top);
    const step = Math.max(1, buckets | 0);
    const bucketSize = 256 / step;
    const bucketsOfColour = new Map();
    let total = 0;

    for (let index = 0; index < bitmap.data.length; index += 4) {
        const r = bitmap.data[index];
        const g = bitmap.data[index + 1];
        const b = bitmap.data[index + 2];
        const key = `${Math.floor(r / bucketSize)},${Math.floor(g / bucketSize)},${Math.floor(b / bucketSize)}`;
        const bucket = bucketsOfColour.get(key) || { count: 0, r: 0, g: 0, b: 0 };

        bucket.count += 1;
        bucket.r += r;
        bucket.g += g;
        bucket.b += b;
        bucketsOfColour.set(key, bucket);
        total += 1;
    }

    // The paper / panel behind the lettering is the most common colour, so the
    // most common clearly different colour is the ink.
    const means = new Map();

    bucketsOfColour.forEach((bucket, key) => {
        means.set(key, {
            r: bucket.r / bucket.count,
            g: bucket.g / bucket.count,
            b: bucket.b / bucket.count,
            count: bucket.count,
        });
    });

    let backgroundKey = null;
    let background = null;

    means.forEach((mean, key) => {
        if (!background || mean.count > background.count) {
            background = mean;
            backgroundKey = key;
        }
    });

    let ink = null;

    means.forEach((mean, key) => {
        if (key === backgroundKey || !background) {
            return;
        }

        const distance = Math.sqrt(
            (mean.r - background.r) ** 2 + (mean.g - background.g) ** 2 + (mean.b - background.b) ** 2,
        );

        if (distance < 60) {
            return;
        }

        if (!ink || mean.count > ink.count) {
            ink = mean;
        }
    });

    const toHex = (mean) => `#${[mean.r, mean.g, mean.b]
        .map((part) => Math.max(0, Math.min(255, Math.round(part))).toString(16).padStart(2, '0'))
        .join('')}`;

    return {
        fill: ink ? toHex(ink) : fallback.fill,
        background: background ? toHex(background) : fallback.background,
        inkRatio: total && ink ? ink.count / total : 0,
    };
}
