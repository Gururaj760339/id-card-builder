<?php

namespace App\Http\Requests;

use App\Rules\SafeImage;
use App\Services\IdCard\IdCardImageService;
use App\Services\IdCard\IdCardSceneSanitizer;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StoreIdCardTemplateRequest extends FormRequest
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
        $copying = $this->filled('_copy_from');
        $requiredDesign = $copying ? 'nullable' : 'required';

        return [
            'name' => ['required', 'string', 'max:150'],
            'status' => ['sometimes', Rule::in(['active', 'draft'])],
            'orientation' => ['required', Rule::in(['landscape', 'portrait'])],
            'card_width' => ['required', 'integer', 'min:200', 'max:5000'],
            'card_height' => ['required', 'integer', 'min:200', 'max:5000'],
            'front_image' => [$requiredDesign, 'file', 'mimes:jpg,jpeg,png', 'max:'.IdCardImageService::MAX_UPLOAD_KB, new SafeImage],
            'back_image' => [$requiredDesign, 'file', 'mimes:jpg,jpeg,png', 'max:'.IdCardImageService::MAX_UPLOAD_KB, new SafeImage],
            'front_elements' => ['required', 'array'],
            'back_elements' => ['required', 'array'],
            'front_elements.elements' => ['array', 'max:'.IdCardSceneSanitizer::MAX_ELEMENTS],
            'back_elements.elements' => ['array', 'max:'.IdCardSceneSanitizer::MAX_ELEMENTS],
            '_copy_from' => ['sometimes', 'integer', 'exists:id_card_templates,id'],
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
            'front_image.required' => 'Upload the front ID card design image (JPG, JPEG or PNG).',
            'back_image.required' => 'Upload the back ID card design image (JPG, JPEG or PNG).',
            'front_image.mimes' => 'The front design must be a JPG, JPEG or PNG image.',
            'back_image.mimes' => 'The back design must be a JPG, JPEG or PNG image.',
            'front_elements.required' => 'The front design configuration is missing.',
            'back_elements.required' => 'The back design configuration is missing.',
        ];
    }
}