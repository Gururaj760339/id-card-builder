@extends('layouts.app')

@section('title', $template->name.' · Preview')

@push('vite')
    @vite(['resources/css/app.css', 'resources/js/idcard/renderer.js'])
@endpush

@section('body')
    <div class="idc-page">
        <header class="idc-page__head">
            <div>
                <a href="{{ route('template.index') }}" class="idc-link">&larr; All templates</a>
                <h1 class="idc-page__title">{{ $template->name }}</h1>
                <p class="idc-page__lead">
                    {{ $template->card_width }} &times; {{ $template->card_height }} px &middot;
                    {{ ucfirst($template->orientation) }} &middot;
                    <span class="idc-tag idc-tag--{{ $template->status }}">{{ ucfirst($template->status) }}</span>
                </p>
            </div>
            <a href="{{ route('id-card-builder.edit', $template) }}" class="idc-btn idc-btn--primary">Edit Template</a>
        </header>

        <div class="idc-preview idc-preview--page">
            <figure class="idc-preview__item">
                <figcaption>Front</figcaption>
                <div class="idc-preview__canvas" data-scene-preview>
                    <script type="application/json" data-role="scene">@json($template->frontScene())</script>
                </div>
            </figure>
            <figure class="idc-preview__item">
                <figcaption>Back</figcaption>
                <div class="idc-preview__canvas" data-scene-preview>
                    <script type="application/json" data-role="scene">@json($template->backScene())</script>
                </div>
            </figure>
        </div>

        <p class="idc-note">
            Hidden layers never appear in the preview. Dynamic fields render their placeholder until the
            rendering system supplies real values.
        </p>
    </div>
@endsection