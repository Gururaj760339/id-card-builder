@extends('layouts.app')

@section('title', 'ID Card Templates')

@push('vite')
    @vite(['resources/css/app.css', 'resources/js/idcard/renderer.js'])
@endpush

@section('body')
    <div class="idc-page">
        <header class="idc-page__head">
            <div>
                <a href="{{ route('home') }}" class="idc-link">&larr; Home</a>
                <h1 class="idc-page__title">ID Card Templates</h1>
                <p class="idc-page__lead">
                    Every saved template stores the original design files plus the customization layers,
                    layer order, styles, QR / barcode configuration and lock state.
                </p>
            </div>
            <a href="{{ route('id-card-builder.index') }}" class="idc-btn idc-btn--primary">New Template</a>
        </header>

        @if (session('status'))
            <div class="idc-notice">{{ session('status') }}</div>
        @endif

        @if ($errors->any())
            <div class="idc-notice idc-notice--error">
                {{ $errors->first() }}
            </div>
        @endif

        <div class="idc-template-grid">
            @forelse ($templates as $template)
                <article class="idc-template">
                    <div class="idc-template__previews">
                        <figure class="idc-template__side">
                            <figcaption>Front</figcaption>
                            <div class="idc-thumb" data-thumb data-label="Front">
                                <script type="application/json" data-role="scene">@json($template['front'])</script>
                            </div>
                        </figure>
                        <figure class="idc-template__side">
                            <figcaption>Back</figcaption>
                            <div class="idc-thumb" data-thumb data-label="Back">
                                <script type="application/json" data-role="scene">@json($template['back'])</script>
                            </div>
                        </figure>
                    </div>

                    <div class="idc-template__body">
                        <h2 class="idc-template__name">{{ $template['name'] }}</h2>
                        <p class="idc-template__meta">
                            <span class="idc-tag idc-tag--{{ $template['status'] }}">{{ ucfirst($template['status']) }}</span>
                            <span>{{ $template['card_width'] }} &times; {{ $template['card_height'] }} px</span>
                            <span>{{ ucfirst($template['orientation']) }}</span>
                        </p>
                        <p class="idc-template__meta">
                            Updated {{ $template['updated_at']?->diffForHumans() ?? 'just now' }}
                            @if ($template['creator'])
                                &middot; by {{ $template['creator'] }}
                            @endif
                        </p>
                    </div>

                    <footer class="idc-template__actions">
                        <a href="{{ $template['edit_url'] }}" class="idc-btn idc-btn--sm">Edit</a>
                        <a href="{{ $template['preview_url'] }}" class="idc-btn idc-btn--sm" target="_blank" rel="noopener">Preview</a>
                        <form method="POST" action="{{ $template['delete_url'] }}" class="idc-form-inline"
                              data-confirm="Delete “{{ $template['name'] }}”? Its database record and its own front/back design files will be removed.">
                            @csrf
                            @method('DELETE')
                            <input type="hidden" name="confirm" value="1">
                            <button type="submit" class="idc-btn idc-btn--sm idc-btn--danger">Delete</button>
                        </form>
                    </footer>
                </article>
            @empty
                <div class="idc-empty-state">
                    <h2>No templates yet</h2>
                    <p>Create your first card design from a front and back image.</p>
                    <a href="{{ route('id-card-builder.index') }}" class="idc-btn idc-btn--primary">Open ID Card Builder</a>
                </div>
            @endforelse
        </div>
    </div>

    <dialog class="idc-dialog" data-role="confirm-dialog">
        <div class="idc-dialog__form">
            <h2 class="idc-dialog__title">Please confirm</h2>
            <p data-role="confirm-text"></p>
            <div class="idc-dialog__actions">
                <button type="button" class="idc-btn idc-btn--ghost" data-action="confirm-cancel">Cancel</button>
                <button type="button" class="idc-btn idc-btn--danger" data-action="confirm-accept">Confirm</button>
            </div>
        </div>
    </dialog>
@endsection