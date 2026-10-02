<?php

namespace App\Http\Requests;

use App\Rules\SafeImage;
use App\Services\IdCard\IdCardImageService;
use App\Services\IdCard\IdCardSceneSanitizer;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class UpdateIdCardTemplateRequest extends FormRequest
{
    /**
     * Determine if the user is authorized to make this request.
     */
    public function authorize(): bool
    {
        return true;
    }

    /**
     * Decode the scene payloads so they can be validated as arrays.
     */
    protected function prepareForValidation(): void
    {
        $merge = [];

        foreach (['front_elements', 'back_elements'] as $key) {
            $value = $this->input($key);

            if (is_string($value) && trim($value) !== '') {
                $decoded = json_decode($value, true);

                if (is_array($decoded)) {
                    $merge[$key] = $decoded;
                }
            }
        }

        if ($merge !== []) {
            $this->merge($merge);
        }
    }

    /**
     * Get the validation rules that apply to the request.
     *
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'name' => ['sometimes', 'required', 'string', 'max:150'],
            'status' => ['sometimes', Rule::in(['active', 'draft'])],
            'orientation' => ['sometimes', 'required', Rule::in(['landscape', 'portrait'])],
            'card_width' => ['sometimes', 'required', 'integer', 'min:200', 'max:5000'],
            'card_height' => ['sometimes', 'required', 'integer', 'min:200', 'max:5000'],
            'front_image' => ['sometimes', 'file', 'mimes:jpg,jpeg,png', 'max:'.IdCardImageService::MAX_UPLOAD_KB, new SafeImage],
            'back_image' => ['sometimes', 'file', 'mimes:jpg,jpeg,png', 'max:'.IdCardImageService::MAX_UPLOAD_KB, new SafeImage],
            'front_elements' => ['sometimes', 'required', 'array'],
            'back_elements' => ['sometimes', 'required', 'array'],
            'front_elements.elements' => ['array', 'max:'.IdCardSceneSanitizer::MAX_ELEMENTS],
            'back_elements.elements' => ['array', 'max:'.IdCardSceneSanitizer::MAX_ELEMENTS],
        ];
    }
}