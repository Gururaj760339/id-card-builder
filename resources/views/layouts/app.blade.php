<!DOCTYPE html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}" class="idc-html">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <meta name="color-scheme" content="light">

    <title>@yield('title', 'ID Card Builder')</title>

    @stack('vite')
    @stack('head')
</head>
<body class="idc-body">
    @yield('body')

    @stack('scripts')
</body>
</html>