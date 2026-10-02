<?php

namespace App\Http\Requests;

use App\Rules\SafeImage;
use App\Services\IdCard\IdCardImageService;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class UploadIdCardAssetRequest extends FormRequest
{
    /**
     * Element kinds that may receive an uploaded image.
     *
     * @var array<int, string>
     */
    public const KINDS = ['photo', 'logo', 'student_signature', 'principal_signature', 'custom'];

    /**
     * Determine if the user is authorized to make this request.
     */
    public function authorize(): bool
    {
        return true;
    }

    /**
     * Get the validation rules that apply to the request.
     *
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'image' => ['required', 'file', 'mimes:jpg,jpeg,png', 'max:'.IdCardImageService::MAX_UPLOAD_KB, new SafeImage(50, 50)],
            'kind' => ['required', 'string', Rule::in(self::KINDS)],
        ];
    }

    /**
     * Get custom messages for validator errors.
     *
     * @return array<string, string>
     */
    public function messages(): array
    {
        return [
            'image.mimes' => 'Only JPG, JPEG and PNG images can be added to the card.',
        ];
    }
}