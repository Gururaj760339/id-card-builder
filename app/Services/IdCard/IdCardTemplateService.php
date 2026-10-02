<?php

namespace App\Services\IdCard;

use App\Models\IdCardTemplate;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;

/**
 * Creates, updates and deletes ID card templates together with the files they
 * own. Original design images are never modified in place: replacing a design
 * stores a brand new file and only then removes the previous one.
 */
class IdCardTemplateService
{
    public function __construct(
        protected IdCardImageService $images,
        protected IdCardSceneSanitizer $scenes,
    ) {}

    /**
     * Store a brand new template.
     *
     * @param  array<string, mixed>  $data
     */
    public function create(array $data, ?UploadedFile $frontImage, ?UploadedFile $backImage, ?int $createdBy = null): IdCardTemplate
    {
        $front = $frontImage ? $this->images->storeDesign($frontImage, 'front') : null;
        $back = $backImage ? $this->images->storeDesign($backImage, 'back') : null;

        try {
            return DB::transaction(fn () => IdCardTemplate::create([
                'name' => $data['name'],
                'front_image' => $front['path'] ?? null,
                'back_image' => $back['path'] ?? null,
                'front_elements' => $data['front_elements'] ?? null,
                'back_elements' => $data['back_elements'] ?? null,
                'card_width' => $data['card_width'],
                'card_height' => $data['card_height'],
                'orientation' => $data['orientation'],
                'status' => $data['status'] ?? IdCardTemplate::STATUS_ACTIVE,
                'created_by' => $createdBy,
            ]));
        } catch (\Throwable $e) {
            $this->images->delete($front['path'] ?? null);
            $this->images->delete($back['path'] ?? null);

            throw $e;
        }
    }

    /**
     * Update an existing template. Missing images keep the stored design.
     *
     * @param  array<string, mixed>  $data
     */
    public function update(IdCardTemplate $template, array $data, ?UploadedFile $frontImage, ?UploadedFile $backImage): IdCardTemplate
    {
        $front = $frontImage ? $this->images->storeDesign($frontImage, 'front') : null;
        $back = $backImage ? $this->images->storeDesign($backImage, 'back') : null;
        $previousFront = $template->front_image;
        $previousBack = $template->back_image;

        try {
            $template->fill([
                'name' => $data['name'] ?? $template->name,
                'card_width' => $data['card_width'] ?? $template->card_width,
                'card_height' => $data['card_height'] ?? $template->card_height,
                'orientation' => $data['orientation'] ?? $template->orientation,
                'status' => $data['status'] ?? $template->status,
                'front_elements' => $data['front_elements'] ?? $template->front_elements,
                'back_elements' => $data['back_elements'] ?? $template->back_elements,
                'front_image' => $front['path'] ?? $template->front_image,
                'back_image' => $back['path'] ?? $template->back_image,
            ])->save();
        } catch (\Throwable $e) {
            $this->images->delete($front['path'] ?? null);
            $this->images->delete($back['path'] ?? null);

            throw $e;
        }

        if ($front !== null) {
            $this->images->delete($previousFront);
        }

        if ($back !== null) {
            $this->images->delete($previousBack);
        }

        return $template->refresh();
    }

/**
 * Duplicate a template (used by "Save as new").
 *
 * Sides that were not re-uploaded are copied from the source template, sides
 * that were re-uploaded are stored fresh, so a partial replacement still ends up
 * with a complete, independent copy of both designs.
 *
 * @param  array<string, mixed>  $data
 */
public function duplicate(IdCardTemplate $source, array $data, ?UploadedFile $frontImage, ?UploadedFile $backImage, ?int $createdBy = null): IdCardTemplate
    {
        $front = $frontImage
            ? $this->images->storeDesign($frontImage, 'front')
            : $this->images->copyDesign($source->front_image, 'front');
        $back = $backImage
            ? $this->images->storeDesign($backImage, 'back')
            : $this->images->copyDesign($source->back_image, 'back');

        try {
            return DB::transaction(fn () => IdCardTemplate::create([
                'name' => $data['name'],
                'front_image' => $front['path'],
                'back_image' => $back['path'],
                'front_elements' => $data['front_elements'] ?? $source->front_elements,
                'back_elements' => $data['back_elements'] ?? $source->back_elements,
                'card_width' => $data['card_width'] ?? $source->card_width,
                'card_height' => $data['card_height'] ?? $source->card_height,
                'orientation' => $data['orientation'] ?? $source->orientation,
                'status' => $data['status'] ?? $source->status,
                'created_by' => $createdBy,
            ]));
        } catch (\Throwable $e) {
            $this->images->delete($front['path']);
            $this->images->delete($back['path']);

            throw $e;
        }
    }

    /**
     * Delete a template and every file that belongs to it.
     */
    public function delete(IdCardTemplate $template): void
    {
        $front = $template->front_image;
        $back = $template->back_image;

        DB::transaction(function () use ($template) {
            $this->deleteElementImages($template);
            $template->delete();
        });

        $this->images->delete($front);
        $this->images->delete($back);
    }

/**
 * Remove the uploaded element assets (photos, logos, signatures) a template
 * references on either side.
 */
protected function deleteElementImages(IdCardTemplate $template): void
    {
        $paths = [];

        foreach ([$template->front_elements, $template->back_elements] as $side) {
            foreach ((array) data_get($side, 'elements', []) as $element) {
                if (! is_array($element)) {
                    continue;
                }

                if ($path = $this->images->pathFromSource($element['src'] ?? null)) {
                    $paths[] = $path;
                }
            }
        }

        foreach (array_unique($paths) as $path) {
            if (! $this->images->isManagedPath($path)) {
                continue;
            }

            // Only remove assets that no other template still points at.
            $stillUsed = IdCardTemplate::query()
                ->whereKeyNot($template->getKey())
                ->where(function ($query) use ($path) {
                    $query->where('front_elements', 'like', '%'.$path.'%')
                        ->orWhere('back_elements', 'like', '%'.$path.'%');
                })
                ->exists();

            if (! $stillUsed) {
                $this->images->delete($path);
            }
        }
    }
}