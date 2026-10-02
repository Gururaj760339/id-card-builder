<?php

namespace App\Services\IdCard;

use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

/**
 * Server side whitelist sanitiser for the builder scene JSON.
 *
 * The browser owns the visual editor, but nothing it sends is trusted: every
 * element is rebuilt key by key with bounded values, and every image source is
 * restricted to a file stored by the builder itself (or a small inline data
 * URL), which keeps the templates free of arbitrary URLs or markup.
 */
class IdCardSceneSanitizer
{
    /**
     * Maximum number of layers a single side may hold.
     */
    public const MAX_ELEMENTS = 300;

    /**
     * Maximum number of erased regions a single side may hold.
     *
     * A mask is one rectangle of flattened artwork that has been removed from
     * the base design because it became an editable layer, so it is bounded in
     * the same way as the layers themselves.
     */
    public const MAX_MASKS = 300;

    /**
     * Maximum size (in bytes) of an inline data URL kept inside a template.
     */
    public const MAX_DATA_URL_BYTES = 1500000;

    /**
     * Minimum / maximum card size in pixels.
     */
    public const MIN_CARD_SIZE = 200;

    public const MAX_CARD_SIZE = 5000;

    /**
     * Supported element types.
     *
     * @var array<int, string>
     */
    public const TYPES = [
        'text',
        'dynamic_text',
        'terms',
        'cover',
        'image',
        'qrcode',
        'barcode',
        'rect',
        'circle',
        'line',
    ];

    /**
     * Types that render text.
     *
     * @var array<int, string>
     */
    public const TEXT_TYPES = ['text', 'dynamic_text', 'terms'];

    /**
     * Types that render a bitmap (image, generated code).
     *
     * @var array<int, string>
     */
    public const IMAGE_TYPES = ['image', 'qrcode', 'barcode'];

    /**
     * Text transforms.
     *
     * @var array<int, string>
     */
    public const TRANSFORMS = ['none', 'uppercase', 'lowercase', 'capitalize'];

    /**
     * Image object fitting.
     *
     * @var array<int, string>
     */
    public const FITS = ['contain', 'cover', 'fill'];

    /**
     * Photo / image frames.
     *
     * @var array<int, string>
     */
    public const FRAMES = ['none', 'circle', 'rounded'];

    /**
     * Barcode symbologies supported by the client side renderer.
     *
     * @var array<int, string>
     */
    public const BARCODE_FORMATS = ['CODE128', 'CODE39', 'EAN13', 'EAN8', 'UPC', 'ITF'];

    /**
     * Data sources for QR codes and barcodes.
     *
     * @var array<int, string>
     */
    public const DATA_SOURCES = ['field', 'custom'];

    /**
     * Sanitise one side of the builder (front or back).
     *
     * @param  array<string, mixed>|string|null  $scene
     * @return array<string, mixed>
     *
     * @throws ValidationException
     */
    public function sanitize(mixed $scene, string $field, string $side): array
    {
        $scene = $this->decode($scene, $field);

        $rawMasks = array_values((array) ($scene['masks'] ?? []));

        if (count($rawMasks) > self::MAX_MASKS) {
            throw ValidationException::withMessages([
                $field.'.masks' => 'A card side cannot hold more than '.self::MAX_MASKS.' erased areas.',
            ]);
        }

        $rawElements = array_values((array) ($scene['elements'] ?? []));

        if (count($rawElements) > self::MAX_ELEMENTS) {
            throw ValidationException::withMessages([
                $field.'.elements' => 'A card side cannot hold more than '.self::MAX_ELEMENTS.' layers.',
            ]);
        }

        $elements = [];
        $seen = [];

        foreach ($rawElements as $index => $element) {
            if (is_string($element)) {
                $element = json_decode($element, true);
            }

            if (! is_array($element)) {
                continue;
            }

            $clean = $this->sanitizeElement($element, $field.'.elements.'.$index);

            if (isset($seen[$clean['id']])) {
                throw ValidationException::withMessages([
                    $field.'.elements.'.$index.'.id' => 'Layer identifiers must be unique.',
                ]);
            }

            $seen[$clean['id']] = true;
            $elements[] = $clean;
        }

        $masks = [];

        foreach (array_slice($rawMasks, 0, self::MAX_MASKS) as $mask) {
            if (is_string($mask)) {
                $mask = json_decode($mask, true);
            }

            if (! is_array($mask)) {
                continue;
            }

            $masks[] = [
                'id' => $this->identifier($mask['id'] ?? null),
                'left' => $this->number($mask['left'] ?? null, -20000, 20000, 0),
                'top' => $this->number($mask['top'] ?? null, -20000, 20000, 0),
                'width' => $this->number($mask['width'] ?? null, 1, 20000, 200),
                'height' => $this->number($mask['height'] ?? null, 1, 20000, 40),
                // The layer this hole was cut for, so deleting that layer can
                // take its own artwork back with it. Hand drawn masks have none.
                'elementId' => $this->optionalIdentifier($mask['elementId'] ?? null),
            ];
        }

        $customFields = [];
        $seenKeys = [];

        foreach (array_slice((array) ($scene['custom_fields'] ?? []), 0, 200) as $custom) {
            if (! is_array($custom)) {
                continue;
            }

            $key = $this->keyName($custom['key'] ?? null);
            $label = $this->label($custom['label'] ?? null);

            if ($key !== '' && $label !== '' && ! isset($seenKeys[$key])) {
                $seenKeys[$key] = true;
                $customFields[] = ['key' => $key, 'label' => $label];
            }
        }

        return [
            'version' => 1,
            'card' => [
                'width' => $this->number($scene['card']['width'] ?? null, self::MIN_CARD_SIZE, self::MAX_CARD_SIZE, 1011, $field.'.card.width'),
                'height' => $this->number($scene['card']['height'] ?? null, self::MIN_CARD_SIZE, self::MAX_CARD_SIZE, 638, $field.'.card.height'),
                'orientation' => $this->oneOf($scene['card']['orientation'] ?? null, ['portrait', 'landscape'], 'landscape'),
            ],
            'background' => [
                'visible' => $this->boolean($scene['background']['visible'] ?? true, true),
                'locked' => true,
            ],
            'custom_fields' => $customFields,
            'elements' => $elements,
            'masks' => $masks,
        ];
    }

    /**
     * Rebuild a single element using only known keys and bounded values.
     *
     * @param  array<string, mixed>  $element
     * @return array<string, mixed>
     *
     * @throws ValidationException
     */
    protected function sanitizeElement(array $element, string $key): array
    {
        $type = $this->elementType($element['type'] ?? null, $key.'.type');

        $clean = [
            'id' => $this->identifier($element['id'] ?? null),
            'name' => $this->label($element['name'] ?? null, ucfirst($type)),
            'type' => $type,
            'left' => $this->number($element['left'] ?? null, -20000, 20000, 0),
            'top' => $this->number($element['top'] ?? null, -20000, 20000, 0),
            'width' => $this->number($element['width'] ?? null, 4, 20000, 200),
            'height' => $this->number($element['height'] ?? null, 4, 20000, 40),
            'angle' => $this->number($element['angle'] ?? null, -360, 360, 0),
            'opacity' => $this->number($element['opacity'] ?? null, 0, 1, 1),
            'visible' => $this->boolean($element['visible'] ?? true, true),
            'locked' => $this->boolean($element['locked'] ?? false, false),
        ];

        if (in_array($type, self::TEXT_TYPES, true)) {
            $clean += [
                'text' => $this->text($element['text'] ?? ''),
                'field' => $type === 'dynamic_text' ? $this->keyName($element['field'] ?? null) : '',
                'placeholder' => $this->label($element['placeholder'] ?? null, ''),
                'fontFamily' => $this->fontFamily($element['fontFamily'] ?? null),
                'fontSize' => $this->number($element['fontSize'] ?? null, 4, 400, 20),
                'fontWeight' => $this->fontWeight($element['fontWeight'] ?? null),
                'italic' => $this->boolean($element['italic'] ?? false, false),
                'underline' => $this->boolean($element['underline'] ?? false, false),
                'fill' => $this->color($element['fill'] ?? null, '#000000'),
                'textAlign' => $this->oneOf($element['textAlign'] ?? null, ['left', 'center', 'right', 'justify'], 'left'),
                'lineHeight' => $this->number($element['lineHeight'] ?? null, 0.5, 5, 1.16),
                'letterSpacing' => $this->number($element['letterSpacing'] ?? null, -20, 60, 0),
                'textTransform' => $this->oneOf($element['textTransform'] ?? null, self::TRANSFORMS, 'none'),
            ];
        }

        if (in_array($type, self::IMAGE_TYPES, true)) {
            $clean += [
                'src' => $this->source($element['src'] ?? null, $key.'.src'),
                'fit' => $this->oneOf($element['fit'] ?? null, self::FITS, 'cover'),
                'frame' => $this->oneOf($element['frame'] ?? null, self::FRAMES, 'none'),
                'radius' => $this->number($element['radius'] ?? null, 0, 2000, 0),
                'strokeWidth' => $this->number($element['strokeWidth'] ?? null, 0, 40, 0),
                'stroke' => $this->color($element['stroke'] ?? null, '#000000'),
            ];
        }

        if ($type === 'qrcode' || $type === 'barcode') {
            $clean += [
                'dataSource' => $this->oneOf($element['dataSource'] ?? null, self::DATA_SOURCES, 'field'),
                'dataField' => $this->keyName($element['dataField'] ?? null),
                'dataValue' => $this->text($element['dataValue'] ?? '', 500),
                'qrEcc' => $this->oneOf($element['qrEcc'] ?? null, ['L', 'M', 'Q', 'H'], 'M'),
                'barcodeFormat' => $this->oneOf($element['barcodeFormat'] ?? null, self::BARCODE_FORMATS, 'CODE128'),
            ];
        }

        if ($type === 'cover' || $type === 'rect') {
            $clean += [
                'bg' => $this->color($element['bg'] ?? $element['fill'] ?? null, '#ffffff'),
                'strokeWidth' => $this->number($element['strokeWidth'] ?? null, 0, 40, 0),
                'stroke' => $this->color($element['stroke'] ?? null, '#000000'),
                'radius' => $this->number($element['radius'] ?? null, 0, 2000, 0),
            ];
        }

        if ($type === 'circle') {
            $clean += [
                'bg' => $this->color($element['bg'] ?? $element['fill'] ?? null, '#ffffff'),
                'strokeWidth' => $this->number($element['strokeWidth'] ?? null, 0, 40, 0),
                'stroke' => $this->color($element['stroke'] ?? null, '#000000'),
            ];
        }

        if ($type === 'line') {
            $clean += [
                'bg' => $this->color($element['bg'] ?? $element['fill'] ?? '#000000', '#000000'),
                'strokeWidth' => $this->number($element['strokeWidth'] ?? null, 1, 40, 3),
            ];
        }

        return $clean;
    }

/**
 * The layer type must be one the renderer knows about.
 *
 * @throws ValidationException
 */
protected function elementType(mixed $value, string $key): string
{
    if (! is_string($value) || ! in_array($value, self::TYPES, true)) {
        throw ValidationException::withMessages([
            $key => 'Unsupported layer type.',
        ]);
    }

    return $value;
}

/**
 * Decode a scene payload that may arrive as an array or a JSON string.
     *
     * @return array<string, mixed>
     *
     * @throws ValidationException
     */
    protected function decode(mixed $scene, string $field): array
    {
        if (is_string($scene)) {
            if (trim($scene) === '') {
                return [];
            }

            $decoded = json_decode($scene, true);

            if (json_last_error() !== JSON_ERROR_NONE || ! is_array($decoded)) {
                throw ValidationException::withMessages([
                    $field => 'The builder configuration is not valid JSON.',
                ]);
            }

            return $decoded;
        }

        if (is_array($scene)) {
            return $scene;
        }

        if ($scene === null) {
            return [];
        }

        throw ValidationException::withMessages([
            $field => 'The builder configuration must be an object.',
        ]);
    }

    /**
     * Only keep images that the builder itself stored (or a small inline image).
     *
     * @throws ValidationException
     */
    protected function source(mixed $value, string $key): string
    {
        if (! is_string($value) || trim($value) === '') {
            return '';
        }

        $value = trim($value);

        if (Str::startsWith($value, ['data:image/png;base64,', 'data:image/jpeg;base64,'])) {
            if (strlen($value) > self::MAX_DATA_URL_BYTES) {
                throw ValidationException::withMessages([$key => 'The inline image is too large.']);
            }

            return $value;
        }

        $disk = Storage::disk('public');
        $images = new IdCardImageService;
        $path = $images->pathFromSource($value);

        if ($path === null) {
            throw ValidationException::withMessages([
                $key => 'Images must be uploaded through the ID Card Builder.',
            ]);
        }

        if (! $disk->exists($path)) {
            throw ValidationException::withMessages([$key => 'The selected image no longer exists.']);
        }

        return (string) $images->publicUrl($path);
    }

    /**
     * Generate a stable, safe element identifier.
     */
    protected function identifier(mixed $value): string
    {
        $value = is_string($value) ? strtolower(preg_replace('/[^A-Za-z0-9_-]/', '', $value) ?? '') : '';

        return $value !== '' ? substr($value, 0, 40) : 'el_'.Str::lower(Str::random(10));
    }

    /**
     * The same identifier, but optional: an absent link stays absent.
     *
     * Used for the mask -> layer link, where "no owner" is a real state (a hole
     * cut by hand) and must not be turned into a random identifier that matches
     * no layer.
     */
    protected function optionalIdentifier(mixed $value): ?string
    {
        $value = is_string($value) ? strtolower(preg_replace('/[^A-Za-z0-9_-]/', '', $value) ?? '') : '';

        return $value !== '' ? substr($value, 0, 40) : null;
    }

    /**
     * Limit a human readable label.
     */
    protected function label(mixed $value, string $default = ''): string
    {
        if (! is_string($value)) {
            return $default;
        }

        $value = trim(preg_replace('/[\x00-\x1F\x7F]/u', '', $value) ?? '');

        return $value === '' ? $default : mb_substr($value, 0, 120);
    }

    /**
     * Multi line plain text (used for terms, labels, code payloads).
     */
    protected function text(mixed $value, int $max = 4000): string
    {
        if (is_int($value) || is_float($value)) {
            $value = (string) $value;
        }

        if (! is_string($value)) {
            return '';
        }

        $value = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $value) ?? '';

        return mb_substr(trim($value), 0, $max);
    }

/**
 * A dynamic field key (student_name, guardian_name, ...).
 *
 * The same normalisation runs in the browser (see normalizeKey in
 * resources/js/idcard/schema.js) so a key typed as "Guardian Name" survives the
 * round trip instead of being silently dropped.
 */
protected function keyName(mixed $value): string
{
    if (! is_string($value)) {
        return '';
    }

    $key = strtolower(trim($value));
    $key = (string) preg_replace('/[^a-z0-9_]+/', '_', $key);
    $key = trim($key, '_');

    if (preg_match('/^[a-z][a-z0-9_]{0,59}$/', $key) !== 1) {
        return '';
    }

    return $key;
}

    /**
     * A safe CSS font family list entry.
     */
    protected function fontFamily(mixed $value): string
    {
        if (! is_string($value)) {
            return 'Arial';
        }

        $value = trim(preg_replace('/[^A-Za-z0-9 ,\'"-]/', '', $value) ?? '');

        if ($value === '') {
            return 'Arial';
        }

        return mb_substr($value, 0, 60);
    }

    /**
     * Font weight: either a keyword or a numeric CSS weight.
     */
    protected function fontWeight(mixed $value): string
    {
        if (is_numeric($value)) {
            $weight = (int) round((float) $value);

            if ($weight >= 100 && $weight <= 900) {
                return (string) $weight;
            }
        }

        if (is_string($value) && in_array(strtolower(trim($value)), ['bold', 'bolder', 'lighter'], true)) {
            return strtolower(trim($value));
        }

        return 'normal';
    }

    /**
     * A colour: hex or rgb()/rgba() only.
     */
    protected function color(mixed $value, string $default): string
    {
        if (! is_string($value)) {
            return $default;
        }

        $value = trim($value);

        if (preg_match('/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/', $value) === 1) {
            return $value;
        }

        if (preg_match('/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(,\s*(0|1|0?\.\d{1,3})\s*)?\)$/i', $value) === 1) {
            return strtolower($value);
        }

        return $default;
    }

    /**
     * Cast to boolean.
     */
    protected function boolean(mixed $value, bool $default): bool
    {
        if (is_bool($value)) {
            return $value;
        }

        if (in_array($value, [1, '1', 'true', 'on', 'yes'], true)) {
            return true;
        }

        if (in_array($value, [0, '0', 'false', 'off', 'no', ''], true)) {
            return false;
        }

        return $default;
    }

    /**
     * Clamp a numeric value inside a range.
     *
     * Values that belong to a validated request field (the card size) are
     * rejected outright, while element geometry coming from the canvas is simply
     * clamped so a layer can never escape the allowed design space.
     *
     * @throws ValidationException
     */
    protected function number(mixed $value, float $min, float $max, float $default, ?string $field = null): float
    {
        if ($value === null || $value === '' || (! is_numeric($value) && ! is_bool($value))) {
            return (float) $default;
        }

        $number = (float) $value;

        if (! is_finite($number)) {
            return (float) $default;
        }

        if ($number < $min || $number > $max) {
            if ($field !== null) {
                throw ValidationException::withMessages([
                    $field => 'The value must be between '.$min.' and '.$max.'.',
                ]);
            }

            return round(max($min, min($max, $number)), 2);
        }

        return round($number, 2);
    }

    /**
     * Keep a value only when it belongs to the given list.
     *
     * @param  array<int, string>  $options
     */
    protected function oneOf(mixed $value, array $options, string $default): string
    {
        if (is_string($value) && in_array($value, $options, true)) {
            return $value;
        }

        return $default;
    }
}