@extends('layouts.app')

@section('title', ($template ? 'Edit · ' : '').'ID Card Builder')

@push('vite')
    @vite(['resources/css/app.css', 'resources/js/idcard/builder.js'])
@endpush

@section('body')
    @php
        $isEdit = (bool) $template;
        $config = [
            'edit' => $isEdit,
            'templateId' => $template?->id,
            'templateName' => $template?->name,
            'storeUrl' => route('id-card-builder.store'),
            'updateUrl' => $isEdit ? route('id-card-builder.update', $template) : '',
            'assetUrl' => route('id-card-builder.assets.store'),
            'templateListUrl' => route('template.index'),
            'homeUrl' => route('home'),
            'card' => [
                'width' => $template?->card_width ?? 1011,
                'height' => $template?->card_height ?? 638,
                'orientation' => $template?->orientation ?? 'landscape',
            ],
            'frontScene' => $isEdit ? $template->frontScene() : null,
            'backScene' => $isEdit ? $template->backScene() : null,
            'dynamicFields' => $dynamicFields,
            'fontFamilies' => $fontFamilies,
            'barcodeFormats' => $barcodeFormats,
            'maxUploadKb' => 5120,
        ];
    @endphp

    <div
        class="idc-builder"
        id="idc-app"
        data-ready="false"
    >
        <script type="application/json" id="idc-config">@json($config)</script>

        <header class="idc-topbar">
            <div class="idc-topbar__brand">
                <a href="{{ route('home') }}" class="idc-topbar__home" title="Back to home">&larr;</a>
                <div class="idc-topbar__titles">
                    <span class="idc-topbar__name">ID Card Builder</span>
                    <span class="idc-topbar__mode" data-role="mode-label">
                        {{ $isEdit ? 'Editing: '.$template->name : 'New template' }}
                    </span>
                </div>
            </div>

            <div class="idc-sideswitch" role="tablist" aria-label="Card side">
                <button type="button" class="idc-sideswitch__btn is-active" data-action="set-side" data-side="front" role="tab" aria-selected="true">
                    Front
                </button>
                <button type="button" class="idc-sideswitch__btn" data-action="set-side" data-side="back" role="tab" aria-selected="false">
                    Back
                </button>
            </div>

            <div class="idc-topbar__actions">
                <button type="button" class="idc-btn" data-action="upload-front">
                    {{ $isEdit ? 'Replace Front' : 'Upload Front Design' }}
                </button>
                <button type="button" class="idc-btn" data-action="upload-back">
                    {{ $isEdit ? 'Replace Back' : 'Upload Back Design' }}
                </button>
                <button type="button" class="idc-btn" data-action="preview">Preview</button>
                <button type="button" class="idc-btn idc-btn--primary" data-action="save">
                    {{ $isEdit ? 'Save Changes' : 'Save Template' }}
                </button>
            </div>
        </header>

        <div class="idc-alert" data-role="alert" hidden></div>

        <main class="idc-workspace">
            <aside class="idc-panel idc-panel--left">
                <div class="idc-panel__scroll">
                    <section class="idc-group">
                        <h2 class="idc-group__title">Base Design</h2>
                        <p class="idc-group__hint">
                            The uploaded JPG/PNG is kept as the untouched original and is never overwritten. Whatever
                            you turn into an editable layer is erased from the background and redrawn on top of it.
                        </p>

                        <div class="idc-design" data-side="front">
                            <div class="idc-design__row">
                                <span class="idc-design__label">Front design</span>
                                <span class="idc-design__state" data-role="front-state">Not uploaded</span>
                            </div>
                            <div class="idc-design__actions">
                                <button type="button" class="idc-btn idc-btn--sm" data-action="upload-front">Upload JPG/PNG</button>
                            </div>
                        </div>

                        <div class="idc-design" data-side="back">
                            <div class="idc-design__row">
                                <span class="idc-design__label">Back design</span>
                                <span class="idc-design__state" data-role="back-state">Not uploaded</span>
                            </div>
                            <div class="idc-design__actions">
                                <button type="button" class="idc-btn idc-btn--sm" data-action="upload-back">Upload JPG/PNG</button>
                            </div>
                        </div>

                        <div class="idc-fields">
                            <label class="idc-field">
                                <span>Card width (px)</span>
                                <input type="number" min="200" max="5000" step="1" data-role="card-width">
                            </label>
                            <label class="idc-field">
                                <span>Card height (px)</span>
                                <input type="number" min="200" max="5000" step="1" data-role="card-height">
                            </label>
                            <label class="idc-field">
                                <span>Orientation</span>
                                <select data-role="card-orientation">
                                    <option value="landscape">Landscape</option>
                                    <option value="portrait">Portrait</option>
                                </select>
                            </label>
                        </div>
                        <p class="idc-group__hint" data-role="card-hint">
                            Dimensions follow the uploaded image so it is never stretched.
                        </p>
                    </section>

                    <section class="idc-group">
                        <h2 class="idc-group__title">Make the Printed Content Editable</h2>
                        <p class="idc-group__hint">
                            The design is a flat JPG/PNG, so its text and images are just pixels. This finds those
                            blocks, erases the original underneath and drops one editable layer per block into the
                            Layers panel — pick a layer to retype, move, resize or delete it, and the other content is
                            never affected.
                        </p>
                        <div class="idc-btn-row">
                            <button type="button" class="idc-btn" data-action="detect-regions">Detect Content</button>
                            <button type="button" class="idc-btn" data-action="add-editable-text">Add Editable Text</button>
                            <button type="button" class="idc-btn" data-action="toggle-regions">Show / Hide Boxes</button>
                            <button type="button" class="idc-btn" data-action="restore-artwork">Restore Original Artwork</button>
                        </div>
                        <p class="idc-group__hint" data-role="region-state"></p>
                    </section>

                    <section class="idc-group">
                        <h2 class="idc-group__title">Cover Existing Text</h2>
                        <p class="idc-group__hint">
                            Use this to hide a block of flat pixels with a solid shape, for example a bar behind a
                            photo. To edit the text itself, use “Make the Printed Content Editable” above.
                        </p>
                        <div class="idc-btn-row">
                            <button type="button" class="idc-btn" data-action="add-element" data-type="cover">Cover / Erase Area</button>
                            <button type="button" class="idc-btn" data-action="replace-text">Replace Existing Text</button>
                        </div>
                    </section>

                    <section class="idc-group">
                        <h2 class="idc-group__title">Text</h2>
                        <div class="idc-btn-row">
                            <button type="button" class="idc-btn" data-action="add-element" data-type="text">Add Text</button>
                            <button type="button" class="idc-btn" data-action="add-element" data-type="terms">Terms &amp; Conditions</button>
                        </div>
                    </section>

                    <section class="idc-group">
                        <h2 class="idc-group__title">Dynamic Fields</h2>
                        <p class="idc-group__hint">
                            Layers store a key (<code>student_name</code>). Student data is provided by the system
                            that renders the card later.
                        </p>

                        @foreach ($dynamicFields as $group => $fields)
                            <div class="idc-fieldgroup" data-field-group="{{ \Illuminate\Support\Str::slug($group) }}">
                                <h3 class="idc-fieldgroup__title">{{ $group }}</h3>
                                <div class="idc-chips">
                                    @foreach ($fields as $field)
                                        <button type="button" class="idc-chip" data-action="add-dynamic"
                                                data-key="{{ $field['key'] }}" data-label="{{ $field['label'] }}">
                                            {{ $field['label'] }}
                                        </button>
                                    @endforeach
                                </div>
                            </div>
                        @endforeach

                        <div class="idc-fieldgroup" data-field-group="custom">
                            <h3 class="idc-fieldgroup__title">Custom fields</h3>
                            <div class="idc-chips" data-role="custom-fields"></div>
                            <div class="idc-customform">
                                <label class="idc-field">
                                    <span>Field name</span>
                                    <input type="text" data-role="custom-label" placeholder="Guardian Name" maxlength="120">
                                </label>
                                <label class="idc-field">
                                    <span>Field key</span>
                                    <input type="text" data-role="custom-key" placeholder="guardian_name" maxlength="60">
                                </label>
                                <div class="idc-btn-row">
                                    <button type="button" class="idc-btn idc-btn--sm" data-action="create-custom-field">Create Field</button>
                                    <button type="button" class="idc-btn idc-btn--sm idc-btn--ghost" data-action="insert-custom-field">Insert Text Field</button>
                                </div>
                            </div>
                        </div>
                    </section>

                    <section class="idc-group">
                        <h2 class="idc-group__title">Images</h2>
                        <div class="idc-btn-row">
                            <button type="button" class="idc-btn" data-action="upload-asset" data-kind="photo">Student Photo</button>
                            <button type="button" class="idc-btn" data-action="upload-asset" data-kind="logo">School Logo</button>
                            <button type="button" class="idc-btn" data-action="upload-asset" data-kind="student_signature">Student Signature</button>
                            <button type="button" class="idc-btn" data-action="upload-asset" data-kind="principal_signature">Principal Signature</button>
                            <button type="button" class="idc-btn" data-action="upload-asset" data-kind="custom">Custom Image</button>
                        </div>
                    </section>

                    <section class="idc-group">
                        <h2 class="idc-group__title">Codes</h2>
                        <div class="idc-btn-row">
                            <button type="button" class="idc-btn" data-action="add-element" data-type="qrcode">QR Code</button>
                            <button type="button" class="idc-btn" data-action="add-element" data-type="barcode">Barcode</button>
                        </div>
                    </section>

                    <section class="idc-group">
                        <h2 class="idc-group__title">Shapes</h2>
                        <div class="idc-btn-row">
                            <button type="button" class="idc-btn" data-action="add-element" data-type="rect">Rectangle</button>
                            <button type="button" class="idc-btn" data-action="add-element" data-type="circle">Circle</button>
                            <button type="button" class="idc-btn" data-action="add-element" data-type="line">Line</button>
                        </div>
                    </section>
                </div>
            </aside>

            <section class="idc-stage">
                <div class="idc-stage__bar">
                    <span class="idc-stage__badge" data-role="side-badge">FRONT</span>
                    <span class="idc-stage__meta" data-role="canvas-meta"></span>
                    <span class="idc-stage__spacer"></span>
                    <div class="idc-zoom">
                        <button type="button" class="idc-btn idc-btn--icon" data-action="zoom-out" title="Zoom out">&minus;</button>
                        <span data-role="zoom-label">100%</span>
                        <button type="button" class="idc-btn idc-btn--icon" data-action="zoom-in" title="Zoom in">+</button>
                        <button type="button" class="idc-btn idc-btn--sm" data-action="zoom-fit">Fit</button>
                    </div>
                </div>

                <div class="idc-stage__scroll" data-role="stage-scroll">
                    <div class="idc-canvas-wrap" data-role="canvas-wrap">
                        <canvas id="idc-canvas"></canvas>
                    </div>
                </div>

                <p class="idc-stage__hint" data-role="stage-hint">
                    Drag to move · corner handles resize · top handle rotates · Delete removes the selection ·
                    Ctrl/Cmd + D duplicates.
                </p>
            </section>

            <aside class="idc-panel idc-panel--right">
                <div class="idc-panel__tabs" role="tablist">
                    <button type="button" class="idc-panel__tab is-active" data-action="panel-tab" data-panel="properties" role="tab">Properties</button>
                    <button type="button" class="idc-panel__tab" data-action="panel-tab" data-panel="layers" role="tab">Layers</button>
                </div>
                <div class="idc-panel__scroll">
                    <div data-role="properties-panel">
                        <p class="idc-empty">Select a layer to edit its position, size and style.</p>
                    </div>
                    <div data-role="layers-panel" hidden></div>
                </div>
            </aside>
        </main>

        <dialog class="idc-dialog" data-role="save-dialog">
            <form method="dialog" class="idc-dialog__form" data-role="save-form">
                <h2 class="idc-dialog__title" data-role="save-title">Save template</h2>

                <label class="idc-field">
                    <span>Template name</span>
                    <input type="text" data-role="save-name" maxlength="150" required placeholder="Modern School Student Card">
                </label>

                <label class="idc-field">
                    <span>Status</span>
                    <select data-role="save-status">
                        <option value="active">Active</option>
                        <option value="draft">Draft</option>
                    </select>
                </label>

                <div class="idc-dialog__errors" data-role="save-errors" hidden></div>

                <div class="idc-dialog__actions">
                    <button type="button" class="idc-btn idc-btn--ghost" data-action="close-dialog">Cancel</button>
                    @if ($isEdit)
                        <button type="button" class="idc-btn" data-action="save-as-new" formnovalidate>Save as New</button>
                        <button type="button" class="idc-btn idc-btn--primary" data-action="save-submit">Save Changes</button>
                    @else
                        <button type="button" class="idc-btn idc-btn--primary" data-action="save-submit">Save Template</button>
                    @endif
                </div>
            </form>
        </dialog>

        <dialog class="idc-dialog idc-dialog--wide" data-role="preview-dialog">
            <div class="idc-dialog__form">
                <h2 class="idc-dialog__title">Front &amp; back preview</h2>
                <div class="idc-preview">
                    <figure class="idc-preview__item">
                        <figcaption>Front</figcaption>
                        <div class="idc-preview__canvas" data-role="preview-front"></div>
                    </figure>
                    <figure class="idc-preview__item">
                        <figcaption>Back</figcaption>
                        <div class="idc-preview__canvas" data-role="preview-back"></div>
                    </figure>
                </div>
                <div class="idc-dialog__actions">
                    <button type="button" class="idc-btn idc-btn--ghost" data-action="close-dialog">Close</button>
                </div>
            </div>
        </dialog>

        <input type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" data-role="file-front" hidden>
        <input type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" data-role="file-back" hidden>
        <input type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" data-role="file-asset" hidden>
    </div>
@endsection