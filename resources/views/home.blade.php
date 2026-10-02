@extends('layouts.app')

@section('title', 'ID Card Builder')

@push('vite')
    @vite(['resources/css/app.css'])
@endpush

@section('body')
    <div class="idc-home">
        <div class="idc-home__card">
            <span class="idc-badge">Laravel · Fabric.js</span>

            <h1 class="idc-home__title">ID Card Builder</h1>

            <p class="idc-home__lead">
                Upload a front and back design image, then build a real card layout on top of it:
                dynamic student fields, photos, logos, signatures, QR codes, barcodes, shapes,
                cover areas and terms &amp; conditions.
            </p>

            <a href="{{ route('id-card-builder.index') }}" class="idc-btn idc-btn--primary idc-btn--xl">
                ID Card Builder
            </a>

            <div class="idc-home__links">
                <a href="{{ route('template.index') }}" class="idc-link">Saved templates</a>
            </div>

            <ul class="idc-home__facts">
                <li><strong>JPG / JPEG / PNG</strong> base designs stay untouched.</li>
                <li>Layer based <strong>cover &amp; replace</strong> for text baked into the image.</li>
                <li>Templates store layout only — student data is supplied at render time.</li>
            </ul>
        </div>
    </div>
@endsection