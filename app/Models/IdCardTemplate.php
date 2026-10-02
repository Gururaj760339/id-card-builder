<?php

namespace App\Models;

use App\Services\IdCard\IdCardImageService;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * @property int $id
 * @property string $name
 * @property ?string $front_image
 * @property ?string $back_image
 * @property ?array<string, mixed> $front_elements
 * @property ?array<string, mixed> $back_elements
 * @property int $card_width
 * @property int $card_height
 * @property string $orientation
 * @property string $status
 * @property ?int $created_by
 */
#[Fillable([
    'name',
    'front_image',
    'back_image',
    'front_elements',
    'back_elements',
    'card_width',
    'card_height',
    'orientation',
    'status',
    'created_by',
])]
class IdCardTemplate extends Model
{
    /**
     * Card statuses.
     */
    public const STATUS_ACTIVE = 'active';

    public const STATUS_DRAFT = 'draft';

    /**
     * Get the attributes that should be cast.
     *
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'front_elements' => 'array',
            'back_elements' => 'array',
            'card_width' => 'integer',
            'card_height' => 'integer',
        ];
    }

    /**
     * The user that created the template.
     */
    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    /**
     * Limit the query to the given status.
     */
    public function scopeWithStatus(Builder $query, string $status): Builder
    {
        return $query->where('status', $status);
    }

    /**
     * The public URL of the front design image (original file is never modified).
     */
    public function frontImageUrl(): ?string
    {
        return $this->imageUrl($this->front_image);
    }

    /**
     * The public URL of the back design image (original file is never modified).
     */
    public function backImageUrl(): ?string
    {
        return $this->imageUrl($this->back_image);
    }

    /**
     * The normalised front scene (background + layers).
     *
     * @return array<string, mixed>
     */
    public function frontScene(): array
    {
        return $this->scene('front');
    }

    /**
     * The normalised back scene (background + layers).
     *
     * @return array<string, mixed>
     */
    public function backScene(): array
    {
        return $this->scene('back');
    }

    /**
     * The URL for one of the stored design images.
     */
    public function imageUrl(?string $path): ?string
    {
        if (blank($path)) {
            return null;
        }

        return app(IdCardImageService::class)->publicUrl($path);
    }

    /**
     * Normalise a stored side of the template into a renderable scene.
     *
     * @return array<string, mixed>
     */
    protected function scene(string $side): array
    {
        $stored = $side === 'front' ? $this->front_elements : $this->back_elements;
        $image = $side === 'front' ? $this->front_image : $this->back_image;
        $data = is_array($stored) ? $stored : [];

        $elements = [];

        foreach ((array) ($data['elements'] ?? []) as $element) {
            if (is_array($element)) {
                $elements[] = $element;
            }
        }

        // The erased regions of the base design. They travel with the scene so a
        // reopened template still shows the flattened artwork removed instead of
        // doubled up behind the editable layers.
        $masks = [];

        foreach ((array) ($data['masks'] ?? []) as $mask) {
            if (is_array($mask)) {
                $masks[] = $mask;
            }
        }

        return [
            'version' => (int) ($data['version'] ?? 1),
            'card' => [
                'width' => (int) ($data['card']['width'] ?? $this->card_width),
                'height' => (int) ($data['card']['height'] ?? $this->card_height),
                'orientation' => (string) ($data['card']['orientation'] ?? $this->orientation),
            ],
            'background' => [
                'src' => $this->imageUrl($image),
                'path' => $image,
                'visible' => (bool) ($data['background']['visible'] ?? true),
                'locked' => true,
            ],
            'custom_fields' => (array) ($data['custom_fields'] ?? []),
            'elements' => $elements,
            'masks' => $masks,
        ];
    }
}