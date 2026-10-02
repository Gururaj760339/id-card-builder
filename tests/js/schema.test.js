import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    DEFAULT_CARD,
    defaultElement,
    keyFromLabel,
    normalizeElement,
    normalizeKey,
    normalizeScene,
    placeholderFor,
    resolveText,
} from '../../resources/js/idcard/schema.js';

const FIELDS = [
    { key: 'student_name', label: 'Student Name' },
    { key: 'guardian_name', label: 'Guardian Name' },
];

describe('normalizeKey', () => {
    it('keeps a valid key untouched', () => {
        assert.equal(normalizeKey('student_name'), 'student_name');
        assert.equal(normalizeKey('  roll  '), 'roll');
    });

    it('turns human input into a key', () => {
        assert.equal(normalizeKey('Guardian Name'), 'guardian_name');
        assert.equal(normalizeKey('Roll-Number!'), 'roll_number');
        assert.equal(normalizeKey('class name 2'), 'class_name_2');
    });

    it('rejects keys that cannot be a variable name', () => {
        assert.equal(normalizeKey(''), '');
        assert.equal(normalizeKey('123'), '');
        assert.equal(normalizeKey('!!!'), '');
        assert.equal(normalizeKey('a'.repeat(61)), '');
    });
});

describe('keyFromLabel', () => {
    it('splits camel case and punctuation', () => {
        assert.equal(keyFromLabel('Guardian Name'), 'guardian_name');
        assert.equal(keyFromLabel('BloodGroup'), 'blood_group');
        assert.equal(keyFromLabel('Class / Section'), 'class_section');
    });
});

describe('normalizeElement', () => {
    it('falls back to a safe default for unknown input', () => {
        const element = normalizeElement({});

        assert.equal(element.type, 'text');
        assert.ok(element.id.length > 0);
        assert.equal(element.visible, true);
        assert.equal(element.locked, false);
        assert.equal(element.opacity, 1);
    });

    it('clamps geometry', () => {
        const element = normalizeElement({ left: -999999, top: 999999, width: 0, height: 99999, angle: 4000, opacity: 12 });

        assert.equal(element.left, -20000);
        assert.equal(element.top, 20000);
        assert.equal(element.width, 4);
        assert.equal(element.height, 20000);
        assert.equal(element.angle, 360);
        assert.equal(element.opacity, 1);
    });

    it('drops unknown keys and unknown types', () => {
        const element = normalizeElement({ type: 'iframe', onclick: 'alert(1)', evil: { x: 1 } });

        assert.equal(element.type, 'text');
        assert.equal(element.onclick, undefined);
        assert.equal(element.evil, undefined);
    });

    it('only accepts images served by the builder', () => {
        const stored = normalizeElement({ type: 'image', src: '/storage/id-card-builder/assets/logo/a.png' });
        const inline = normalizeElement({ type: 'image', src: 'data:image/png;base64,AAAA' });
        const remote = normalizeElement({ type: 'image', src: 'https://example.com/tracker.png' });
        const traversal = normalizeElement({ type: 'image', src: '/storage/id-card-builder/../../secret.png' });

        assert.equal(stored.src, '/storage/id-card-builder/assets/logo/a.png');
        assert.equal(inline.src, 'data:image/png;base64,AAAA');
        assert.equal(remote.src, '');
        assert.equal(traversal.src, '');
    });

    it('sanitises colours', () => {
        assert.equal(normalizeElement({ fill: 'url(javascript:alert(1))' }).fill, '#111111');
        assert.equal(normalizeElement({ fill: '#ff0000' }).fill, '#ff0000');
        assert.equal(normalizeElement({ type: 'rect', bg: 'rgba(0, 0, 0, 0.5)' }).bg, 'rgba(0, 0, 0, 0.5)');
        assert.equal(normalizeElement({ type: 'rect', bg: 'expression(alert(1))' }).bg, '#1d4ed8');
    });

    it('keeps a missing visible flag visible', () => {
        assert.equal(normalizeElement({ visible: undefined }).visible, true);
        assert.equal(normalizeElement({ visible: false }).visible, false);
        assert.equal(normalizeScene({ background: {} }).background.visible, true);
    });

    it('truncates long text', () => {
        assert.equal(normalizeElement({ text: 'x'.repeat(5000) }).text.length, 4000);
        assert.equal(normalizeElement({ name: 'n'.repeat(200) }).name.length, 120);
    });

    it('keeps the code payload options of a qr layer', () => {
        const qr = normalizeElement({
            type: 'qrcode',
            dataSource: 'custom',
            dataField: 'Roll Number',
            dataValue: 'ID-1',
            qrEcc: 'H',
            barcodeFormat: 'EAN13',
        });

        assert.equal(qr.type, 'qrcode');
        assert.equal(qr.dataSource, 'custom');
        assert.equal(qr.dataField, 'roll_number');
        assert.equal(qr.dataValue, 'ID-1');
        assert.equal(qr.qrEcc, 'H');
    });
});

describe('defaultElement', () => {
    it('creates usable defaults for every button in the editor', () => {
        for (const type of ['text', 'terms', 'cover', 'image', 'qrcode', 'barcode', 'rect', 'circle', 'line']) {
            const element = defaultElement(type);

            assert.equal(element.type, type);
            assert.ok(element.width > 0 && element.height > 0, `${type} needs a size`);
        }
    });
});

describe('normalizeScene', () => {
    it('always produces a complete scene', () => {
        const scene = normalizeScene();

        assert.equal(scene.version, 1);
        assert.deepEqual(scene.card, DEFAULT_CARD);
        assert.equal(scene.background.locked, true);
        assert.deepEqual(scene.elements, []);
        assert.deepEqual(scene.custom_fields, []);
        assert.deepEqual(scene.masks, []);
    });

    it('keeps valid custom fields and drops broken ones', () => {
        const scene = normalizeScene({
            custom_fields: [
                { key: 'Guardian Name', label: 'Guardian' },
                { key: '', label: 'Broken' },
                { key: 'class', label: 'Class' },
            ],
        });

        assert.deepEqual(scene.custom_fields, [
            { key: 'guardian_name', label: 'Guardian' },
            { key: 'class', label: 'Class' },
        ]);
    });

    it('clamps the card size and ignores a bad orientation', () => {
        const scene = normalizeScene({ card: { width: 10, height: 99999, orientation: 'diagonal' } });

        assert.equal(scene.card.width, 200);
        assert.equal(scene.card.height, 5000);
        assert.equal(scene.card.orientation, 'landscape');
    });

    it('never trusts the background definition', () => {
        const scene = normalizeScene({ background: { visible: true, locked: false, src: 'https://example.com/a.png' } });

        assert.equal(scene.background.locked, true);
        assert.equal(scene.background.src, undefined);
    });

    it('keeps valid masks and strips unsafe properties', () => {
        const scene = normalizeScene({
            masks: [
                { id: 'mk_name', left: 10, top: 20, width: 200, height: 40, elementId: 'el_name' },
                { id: 'mk_bad', left: 'ten', top: null, width: 0, height: -5 },
                { elementId: 'no-geometry' },
                'not-an-object',
            ],
        });

        assert.equal(scene.masks.length, 3);
        assert.equal(scene.masks[0].id, 'mk_name');
        assert.equal(scene.masks[0].left, 10);
        assert.equal(scene.masks[0].top, 20);
        assert.equal(scene.masks[0].width, 200);
        assert.equal(scene.masks[0].height, 40);
        assert.equal(scene.masks[0].elementId, 'el_name');
        // A mask can never reach outside the stored design: unusable numbers fall
        // back to the lower bound and a negative or zero size becomes 1.
        assert.equal(scene.masks[1].left, -20000);
        assert.equal(scene.masks[1].width, 1);
        assert.equal(scene.masks[1].height, 1);
        assert.equal(scene.masks[1].elementId, null);
        assert.equal(scene.masks[2].left, -20000);
        assert.equal(scene.masks[2].width, 1);
        assert.equal(scene.masks[2].elementId, 'no-geometry');
    });
});

describe('resolveText', () => {
    it('renders the value supplied by the consuming system', () => {
        const element = defaultElement('dynamic_text', { field: 'student_name' });

        assert.equal(resolveText(element, { student_name: 'Ayesha Khan' }, FIELDS), 'Ayesha Khan');
    });

    it('shows a readable placeholder while no data is supplied', () => {
        const element = defaultElement('dynamic_text', { field: 'guardian_name' });

        assert.equal(resolveText(element, {}, FIELDS), '[Guardian Name]');
        assert.equal(resolveText(element, { guardian_name: '   ' }, FIELDS), '[Guardian Name]');
    });

    it('uses the custom payload of a code layer', () => {
        const element = defaultElement('qrcode', { dataSource: 'custom', dataValue: 'ID-42' });

        assert.equal(resolveText(element, {}, FIELDS), 'ID-42');
    });

    it('falls back to the placeholder of an unbound layer', () => {
        assert.equal(placeholderFor({ placeholder: 'Roll Number' }), 'Roll Number');
        assert.equal(placeholderFor({ field: 'roll' }), 'roll');
        assert.equal(placeholderFor({ field: 'roll' }, FIELDS), 'roll');
        assert.equal(placeholderFor({}), 'Value');
    });
});