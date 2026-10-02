<?php

namespace App\Http\Controllers;

use App\Models\IdCardTemplate;
use Illuminate\View\View;

class IdCardTemplateController extends Controller
{
    /**
     * List every saved card template with its real design previews.
     */
    public function index(): View
    {
        $templates = IdCardTemplate::query()
            ->with('creator')
            ->latest('updated_at')
            ->get()
            ->map(fn (IdCardTemplate $template) => [
                'id' => $template->id,
                'name' => $template->name,
                'status' => $template->status,
                'orientation' => $template->orientation,
                'card_width' => $template->card_width,
                'card_height' => $template->card_height,
                'updated_at' => $template->updated_at,
                'creator' => $template->creator?->name,
                'front' => $template->frontScene(),
                'back' => $template->backScene(),
                'edit_url' => route('id-card-builder.edit', $template),
                'preview_url' => route('template.preview', $template),
                'delete_url' => route('id-card-builder.destroy', $template),
            ]);

        return view('id-card.templates', [
            'templates' => $templates,
        ]);
    }
}