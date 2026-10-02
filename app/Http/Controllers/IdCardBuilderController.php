<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreIdCardTemplateRequest;
use App\Http\Requests\UpdateIdCardTemplateRequest;
use App\Http\Requests\UploadIdCardAssetRequest;
use App\Models\IdCardTemplate;
use App\Services\IdCard\IdCardImageService;
use App\Services\IdCard\IdCardSceneSanitizer;
use App\Services\IdCard\IdCardTemplateService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Validation\ValidationException;
use Illuminate\View\View;
use RuntimeException;
use Throwable;

class IdCardBuilderController extends Controller
{
    public function __construct(
        protected IdCardSceneSanitizer $scenes,
        protected IdCardTemplateService $templates,
        protected IdCardImageService $images,
    ) {}

    /**
     * The visual builder for a brand new card.
     */
    public function index(): View
    {
        return view('id-card.builder', [
            'template' => null,
            'dynamicFields' => $this->dynamicFieldCatalog(),
            'fontFamilies' => $this->fontFamilies(),
            'barcodeFormats' => IdCardSceneSanitizer::BARCODE_FORMATS,
        ]);
    }

    /**
     * Open a saved template for editing.
     */
    public function edit(IdCardTemplate $template): View
    {
        return view('id-card.builder', [
            'template' => $template,
            'dynamicFields' => $this->dynamicFieldCatalog(),
            'fontFamilies' => $this->fontFamilies(),
            'barcodeFormats' => IdCardSceneSanitizer::BARCODE_FORMATS,
        ]);
    }

    /**
     * Persist a new template (also used by "save as new").
     */
    public function store(StoreIdCardTemplateRequest $request): RedirectResponse
    {
        $data = $this->validatedPayload($request);

        try {
            $copyFrom = $request->filled('_copy_from')
                ? IdCardTemplate::findOrFail($request->integer('_copy_from'))
                : null;

            $template = $copyFrom
                ? $this->templates->duplicate(
                    $copyFrom,
                    $data,
                    $request->file('front_image'),
                    $request->file('back_image'),
                    Auth::id(),
                )
                : $this->templates->create(
                    $data,
                    $request->file('front_image'),
                    $request->file('back_image'),
                    Auth::id(),
                );
        } catch (RuntimeException $e) {
            throw ValidationException::withMessages(['front_image' => $e->getMessage()]);
        }

        return redirect()
            ->route('template.index')
            ->with('status', 'Template "'.$template->name.'" saved successfully.');
    }

    /**
     * Update an existing template in place.
     */
    public function update(UpdateIdCardTemplateRequest $request, IdCardTemplate $template): RedirectResponse
    {
        $data = $this->validatedPayload($request, partial: true);

        try {
            $this->templates->update(
                $template,
                $data,
                $request->file('front_image'),
                $request->file('back_image'),
            );
        } catch (RuntimeException $e) {
            throw ValidationException::withMessages(['front_image' => $e->getMessage()]);
        }

        return redirect()
            ->route('template.index')
            ->with('status', 'Template "'.$template->name.'" updated successfully.');
    }

    /**
     * Delete a template with its own files.
     */
    public function destroy(Request $request, IdCardTemplate $template): RedirectResponse
    {
        abort_unless($request->boolean('confirm'), 422, 'Deletion was not confirmed.');

        $name = $template->name;

        try {
            $this->templates->delete($template);
        } catch (Throwable $e) {
            report($e);

            return back()->withErrors(['template' => 'The template could not be deleted.']);
        }

        return redirect()
            ->route('template.index')
            ->with('status', 'Template "'.$name.'" deleted.');
    }

    /**
     * Read only front + back preview of a saved template.
     */
    public function preview(IdCardTemplate $template): View
    {
        return view('id-card.preview', [
            'template' => $template,
        ]);
    }

    /**
     * Upload an element image (photo, logo, signature, custom image).
     */
    public function storeAsset(UploadIdCardAssetRequest $request): JsonResponse
    {
        try {
            $asset = $this->images->storeAsset($request->file('image'), $request->string('kind')->value());
        } catch (RuntimeException $e) {
            throw ValidationException::withMessages(['image' => $e->getMessage()]);
        }

        return response()->json($asset);
    }

    /**
     * Build the sanitised payload shared by store() and update().
     *
     * @return array<string, mixed>
     */
    protected function validatedPayload(StoreIdCardTemplateRequest|UpdateIdCardTemplateRequest $request, bool $partial = false): array
    {
        $payload = [];

        if ($request->filled('name')) {
            $payload['name'] = $request->string('name')->trim()->value();
        }

        foreach (['card_width', 'card_height', 'orientation', 'status'] as $key) {
            if ($request->filled($key) || (! $partial && $request->has($key))) {
                $payload[$key] = $request->input($key);
            }
        }

        if ($request->has('front_elements')) {
            $payload['front_elements'] = $this->scenes->sanitize(
                $request->input('front_elements'),
                'front_elements',
                'front',
            );
        }

        if ($request->has('back_elements')) {
            $payload['back_elements'] = $this->scenes->sanitize(
                $request->input('back_elements'),
                'back_elements',
                'back',
            );
        }

        return $payload;
    }

    /**
     * The dynamic field keys offered by the builder.
     *
     * The builder only stores the key: the actual student data is supplied by
     * whatever system renders the card later.
     *
     * @return array<string, array<int, array{key: string, label: string}>>
     */
    protected function dynamicFieldCatalog(): array
    {
        return [
            'Student' => [
                ['key' => 'student_name', 'label' => 'Student Name'],
                ['key' => 'student_id', 'label' => 'Student ID'],
                ['key' => 'admission_number', 'label' => 'Admission Number'],
                ['key' => 'roll', 'label' => 'Roll Number'],
                ['key' => 'class', 'label' => 'Class'],
                ['key' => 'section', 'label' => 'Section'],
                ['key' => 'session', 'label' => 'Session'],
                ['key' => 'dob', 'label' => 'Date of Birth'],
                ['key' => 'blood_group', 'label' => 'Blood Group'],
                ['key' => 'gender', 'label' => 'Gender'],
                ['key' => 'phone', 'label' => 'Phone'],
                ['key' => 'email', 'label' => 'Email'],
                ['key' => 'address', 'label' => 'Address'],
            ],
            'School' => [
                ['key' => 'school_name', 'label' => 'School Name'],
                ['key' => 'school_address', 'label' => 'School Address'],
                ['key' => 'school_phone', 'label' => 'School Phone'],
                ['key' => 'school_email', 'label' => 'School Email'],
                ['key' => 'school_website', 'label' => 'School Website'],
            ],
            'Other' => [
                ['key' => 'issue_date', 'label' => 'Issue Date'],
                ['key' => 'expiry_date', 'label' => 'Expiry Date'],
                ['key' => 'certificate_number', 'label' => 'Certificate / ID Number'],
            ],
        ];
    }

    /**
     * Font families offered by the settings panel.
     *
     * @return array<int, string>
     */
    protected function fontFamilies(): array
    {
        return [
            'Arial',
            'Helvetica',
            'Verdana',
            'Tahoma',
            'Trebuchet MS',
            'Georgia',
            'Times New Roman',
            'Palatino Linotype',
            'Courier New',
            'Impact',
            'Comic Sans MS',
            'Segoe UI',
            'Roboto',
            'Open Sans',
            'Instrument Sans',
        ];
    }
}