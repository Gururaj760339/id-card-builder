<?php

namespace App\Rules;

use App\Services\IdCard\IdCardImageService;
use Closure;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Http\UploadedFile;
use RuntimeException;

/**
 * Confirms an upload really is a JPG/JPEG/PNG image by reading its binary
 * content: the client supplied name and MIME header are never trusted.
 */
class SafeImage implements ValidationRule
{
    /**
     * @param  int  $minWidth  smallest accepted pixel width
     * @param  int  $minHeight  smallest accepted pixel height
     */
    public function __construct(
        protected int $minWidth = 100,
        protected int $minHeight = 100,
    ) {}

    /**
     * Run the validation rule.
     */
    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if (! $value instanceof UploadedFile || ! $value->isValid()) {
            $fail('The :attribute upload failed.');

            return;
        }

        try {
            $meta = app(IdCardImageService::class)->inspect($value->getRealPath());
        } catch (RuntimeException $e) {
            $fail($e->getMessage());

            return;
        }

        if ($meta['width'] < $this->minWidth || $meta['height'] < $this->minHeight) {
            $fail("The :attribute must be at least {$this->minWidth}x{$this->minHeight} pixels.");
        }
    }
}