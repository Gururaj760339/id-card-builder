<?php

use App\Http\Controllers\IdCardBuilderController;
use App\Http\Controllers\IdCardTemplateController;
use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    return view('home');
})->name('home');

/*
|--------------------------------------------------------------------------
| ID Card Builder
|--------------------------------------------------------------------------
*/
Route::prefix('id-card-builder')->name('id-card-builder.')->group(function () {
    Route::get('/', [IdCardBuilderController::class, 'index'])->name('index');
    Route::post('/', [IdCardBuilderController::class, 'store'])->name('store');
    Route::post('assets', [IdCardBuilderController::class, 'storeAsset'])->name('assets.store');
    Route::get('{template}/edit', [IdCardBuilderController::class, 'edit'])->name('edit');
    Route::match(['put', 'patch'], '{template}', [IdCardBuilderController::class, 'update'])->name('update');
    Route::delete('{template}', [IdCardBuilderController::class, 'destroy'])->name('destroy');
});

/*
|--------------------------------------------------------------------------
| Saved templates
|--------------------------------------------------------------------------
*/
Route::prefix('template')->name('template.')->group(function () {
    Route::get('/', [IdCardTemplateController::class, 'index'])->name('index');
    Route::get('{template}/preview', [IdCardBuilderController::class, 'preview'])->name('preview');
});