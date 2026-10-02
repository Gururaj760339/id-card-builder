<?php

namespace App\Services\IdCard;

use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use RuntimeException;

/**
 * Stores and removes every file owned by the ID Card Builder.
 *
 * Uploads are stored on the public disk inside a dedicated directory, are given
 * a random unique name and are never executed or trusted by their client side
 * file name: the extension is derived from the real image MIME type.
 */
class IdCardImageService
{
    /**
     * Root directory (on the public disk) used by every builder file.
     */
    public const DIRECTORY = 'id-card-builder';

    /**
     * Allowed image MIME types mapped to the extension used when storing.
     *
     * @var array<string, string>
     */
    public const ALLOWED_MIME_TYPES = [
        'image/jpeg' => 'jpg',
        'image/pjpeg' => 'jpg',
        'image/png' => 'png',
    ];

    /**
     * Sub directory used for the uploaded base designs (front / back).
     */
    public const DESIGNS_DIRECTORY = 'id-card-builder/designs';

    /**
     * Sub directory used for element assets (photos, logos, signatures).
     */
    public const ASSETS_DIRECTORY = 'id-card-builder/assets';

    /**
     * Maximum allowed upload size in kilobytes.
     */
    public const MAX_UPLOAD_KB = 5120;

    /**
     * Store an uploaded design image (front or back base design).
     *
     * @return array{path: string, url: string, width: int, height: int, mime: string, bytes: int}
     */
    public function storeDesign(UploadedFile $file, string $side): array
    {
        $stored = $this->store($file, self::DESIGNS_DIRECTORY.'/'.$side);

        return [
            'path' => $stored['path'],
            'url' => $stored['url'],
            ...$stored['meta'],
        ];
    }

    /**
     * Store an uploaded element asset (photo, logo, signature, ...).
     *
     * @return array{path: string, url: string, width: int, height: int, mime: string, bytes: int}
     */
    public function storeAsset(UploadedFile $file, string $kind = 'misc'): array
    {
        $kind = preg_replace('/[^a-z0-9_-]/i', '', $kind) ?: 'misc';

        $stored = $this->store($file, self::ASSETS_DIRECTORY.'/'.$kind);

        return [
            'path' => $stored['path'],
            'url' => $stored['url'],
            ...$stored['meta'],
        ];
    }

    /**
     * Copy an already stored design so "save as new" keeps the original files intact.
     *
     * @return array{path: string, url: string, width: int, height: int, mime: string, bytes: int}
     */
    public function copyDesign(?string $path, string $side): array
    {
        $disk = Storage::disk('public');

        if (blank($path) || ! $disk->exists($path)) {
            throw new RuntimeException('The source design image could not be found.');
        }

        $absolute = $disk->path($path);
        $meta = $this->imageMeta($absolute);
        $target = $this->uniqueName($meta['mime']);
        $newPath = self::DESIGNS_DIRECTORY.'/'.$side.'/'.$target;

        $disk->put($newPath, $disk->get($path));

        return [
            'path' => $newPath,
            'url' => $this->publicUrl($newPath),
            ...$meta,
        ];
    }

/**
 * Canonical, host independent URL for a stored builder file.
 *
 * Relative URLs are used on purpose: a template may be rendered on another
 * host (or from a queue worker) without rewriting every stored scene, and the
 * client side schema only ever accepts the `/storage/id-card-builder/...` form.
 */
public function publicUrl(?string $path): ?string
    {
        if (blank($path) || ! $this->isManagedPath($path)) {
            return null;
        }

        return '/storage/'.ltrim($path, '/');
    }

    /**
     * Reduce an image reference coming from the browser to a managed disk path.
     *
     * Accepts the relative `/storage/...` form, an absolute URL on any host (the
     * asset endpoint hands the browser a URL that is echoed back inside the
     * scene JSON) and a bare managed path. Anything else - a remote host, a data
     * URL, a traversal attempt - returns null.
     */
    public function pathFromSource(mixed $source): ?string
    {
        if (! is_string($source)) {
            return null;
        }

        $value = trim($source);

        if ($value === '') {
            return null;
        }

        $parsed = parse_url($value);

        if (is_array($parsed) && isset($parsed['scheme'])) {
            if (! in_array(strtolower($parsed['scheme']), ['http', 'https'], true)) {
                return null;
            }

            $value = (string) ($parsed['path'] ?? '');
        }

        $value = ltrim($value, '/');

        if (Str::startsWith($value, 'storage/')) {
            $value = (string) Str::after($value, 'storage/');
        }

        return $this->isManagedPath($value) ? $value : null;
    }

    /**
     * Delete a stored file, but only when it belongs to the builder directory.
     */
    public function delete(?string $path): bool
    {
        if (blank($path) || ! $this->isManagedPath($path)) {
            return false;
        }

        return Storage::disk('public')->delete($path);
    }

    /**
     * Read the dimensions of an uploaded file without trusting it.
     *
     * @return array{width: int, height: int}
     */
    public function dimensions(UploadedFile $file): array
    {
        $meta = $this->imageMeta($file->getRealPath());

        return ['width' => $meta['width'], 'height' => $meta['height']];
    }

    /**
     * Inspect an image file and return its real type, size and pixel dimensions.
     *
     * @return array{width: int, height: int, mime: string, bytes: int}
     *
     * @throws RuntimeException When the file is not a usable JPG/JPEG/PNG image.
     */
    public function inspect(string $absolutePath): array
    {
        return $this->imageMeta($absolutePath);
    }

    /**
     * Make sure the given path is inside a managed builder directory.
     */
    public function isManagedPath(?string $path): bool
    {
        if (blank($path) || str_contains($path, '..') || str_starts_with($path, '/')) {
            return false;
        }

        return str_starts_with($path, self::DIRECTORY.'/');
    }

    /**
     * Store the file on disk with a safe unique name.
     *
     * @return array{path: string, url: string, meta: array{width: int, height: int, mime: string, bytes: int}}
     */
    protected function store(UploadedFile $file, string $directory): array
    {
        $meta = $this->imageMeta($file->getRealPath());
        $name = $this->uniqueName($meta['mime']);
        $path = trim($directory, '/').'/'.$name;

        $disk = Storage::disk('public');

        if (! $disk->put($path, file_get_contents($file->getRealPath()))) {
            throw new RuntimeException('The uploaded file could not be stored.');
        }

        return [
            'path' => $path,
            'url' => $this->publicUrl($path),
            'meta' => $meta,
        ];
    }

    /**
     * Build a random, collision free file name using the real image type.
     */
    protected function uniqueName(string $mime): string
    {
        $extension = self::ALLOWED_MIME_TYPES[$mime] ?? null;

        if ($extension === null) {
            throw new RuntimeException('Only JPG, JPEG and PNG images are supported.');
        }

        return Str::uuid()->toString().'.'.$extension;
    }

    /**
     * Inspect a real image file: MIME type, size and pixel dimensions.
     *
     * @return array{width: int, height: int, mime: string, bytes: int}
     */
    protected function imageMeta(string $absolutePath): array
    {
        $info = @getimagesize($absolutePath);

        if ($info === false || empty($info['mime'])) {
            throw new RuntimeException('The uploaded file is not a valid image.');
        }

        $mime = strtolower($info['mime']);

        if (! array_key_exists($mime, self::ALLOWED_MIME_TYPES)) {
            throw new RuntimeException('Only JPG, JPEG and PNG images are supported.');
        }

        $bytes = (int) @filesize($absolutePath);

        if ($bytes <= 0 || $bytes > self::MAX_UPLOAD_KB * 1024) {
            throw new RuntimeException('The uploaded image is empty or too large.');
        }

        return [
            'width' => (int) $info[0],
            'height' => (int) $info[1],
            'mime' => $mime,
            'bytes' => $bytes,
        ];
    }
}