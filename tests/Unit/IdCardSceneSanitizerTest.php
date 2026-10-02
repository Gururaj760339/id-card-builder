<?php

namespace Tests\Unit;

use App\Services\IdCard\IdCardSceneSanitizer;
use Illuminate\Validation\ValidationException;
use Tests\TestCase;

class IdCardSceneSanitizerTest extends TestCase
{
    private IdCardSceneSanitizer $sanitizer;

    protected function setUp(): void
    {
        parent::setUp();

        $this->sanitizer = new IdCardSceneSanitizer();
    }

    private function element(array $overrides = []): array
    {
        return array_merge([
            'id' => 'el_1',
            'name' => 'Student Name',
            'type' => 'dynamic_text',
            'left' => 100,
            'top' => 120,
            'width' => 300,
            'height' => 44,
            'angle' => 0,
            'opacity' => 1,
            'visible' => true,
            'locked' => false,
            'text' => '',
            'field' => 'student_name',
            'fontFamily' => 'Arial',
            'fontSize' => 20,
            'fill' => '#000000',
        ], $overrides);
    }

    public function test_it_keeps_only_known_keys(): void
    {
        $scene = $this->sanitizer->sanitize([
            'elements' => [$this->element([
                'onclick' => 'alert(1)',
                'customData' => ['x' => 1],
                'data' => '<script>alert(1)</script>',
            ])],
        ], 'front_elements', 'front');

        $element = $scene['elements'][0];

        $this->assertArrayNotHasKey('onclick', $element);
        $this->assertArrayNotHasKey('customData', $element);
        $this->assertArrayNotHasKey('data', $element);
        $this->assertSame('el_1', $element['id']);
        $this->assertSame('dynamic_text', $element['type']);
    }

    public function test_it_keeps_the_background_non_interactive(): void
    {
        $scene = $this->sanitizer->sanitize([
            'background' => ['visible' => false, 'locked' => false, 'src' => 'https://example.com/a.png'],
        ], 'front_elements', 'front');

        $this->assertFalse($scene['background']['visible']);
        $this->assertTrue($scene['background']['locked']);
        $this->assertArrayNotHasKey('src', $scene['background']);
    }

    public function test_it_clamps_geometry_and_opacity(): void
    {
        $scene = $this->sanitizer->sanitize([
            'elements' => [$this->element([
                'left' => -40000,
                'top' => 40000,
                'width' => 0,
                'height' => -12,
                'opacity' => -3,
                'angle' => 900,
            ])],
        ], 'front_elements', 'front');

        $element = $scene['elements'][0];

        $this->assertEquals(-20000, $element['left']);
        $this->assertEquals(20000, $element['top']);
        $this->assertEquals(4, $element['width']);
        $this->assertEquals(4, $element['height']);
        $this->assertEquals(0, $element['opacity']);
        $this->assertEquals(360, $element['angle']);
    }

    public function test_it_rejects_a_card_size_outside_the_supported_range(): void
    {
        $this->expectException(ValidationException::class);

        $this->sanitizer->sanitize(['card' => ['width' => 5, 'height' => 638]], 'front_elements', 'front');
    }

    public function test_it_rejects_unknown_element_types(): void
    {
        $this->expectException(ValidationException::class);

        $this->sanitizer->sanitize([
            'elements' => [$this->element(['type' => 'iframe'])],
        ], 'front_elements', 'front');
    }

    public function test_it_rejects_duplicate_element_ids(): void
    {
        $this->expectException(ValidationException::class);

        $this->sanitizer->sanitize([
            'elements' => [$this->element(), $this->element(['type' => 'cover'])],
        ], 'front_elements', 'front');
    }

    public function test_it_normalises_dynamic_field_keys(): void
    {
        $scene = $this->sanitizer->sanitize([
            'elements' => [
                $this->element(['field' => ' Roll Number! ']),
                $this->element(['id' => 'el_2', 'type' => 'text', 'field' => 'ignored']),
            ],
        ], 'front_elements', 'front');

        $this->assertSame('roll_number', $scene['elements'][0]['field']);
        $this->assertSame('', $scene['elements'][1]['field']);
    }

    public function test_it_keeps_only_valid_custom_fields(): void
    {
        $scene = $this->sanitizer->sanitize([
            'custom_fields' => [
                ['key' => 'Guardian Name', 'label' => 'Guardian'],
                ['key' => '', 'label' => 'Broken'],
                ['key' => 'class', 'label' => 'Class'],
            ],
        ], 'front_elements', 'front');

        $this->assertSame([
            ['key' => 'guardian_name', 'label' => 'Guardian'],
            ['key' => 'class', 'label' => 'Class'],
        ], $scene['custom_fields']);
    }

    public function test_it_drops_duplicate_custom_field_keys(): void
    {
        $scene = $this->sanitizer->sanitize([
            'custom_fields' => [
                ['key' => 'class', 'label' => 'Class'],
                ['key' => 'Class', 'label' => 'Duplicate'],
            ],
        ], 'front_elements', 'front');

        $this->assertSame([['key' => 'class', 'label' => 'Class']], $scene['custom_fields']);
    }

    public function test_it_truncates_over_long_text(): void
    {
        $scene = $this->sanitizer->sanitize([
            'elements' => [$this->element(['type' => 'text', 'text' => str_repeat('ab', 5000)])],
        ], 'front_elements', 'front');

        $this->assertSame(4000, mb_strlen($scene['elements'][0]['text']));
    }

    public function test_it_caps_the_number_of_elements(): void
    {
        $elements = [];

        for ($i = 0; $i < 400; $i++) {
            $elements[] = $this->element(['id' => 'el_'.$i]);
        }

        $this->expectException(ValidationException::class);

        $this->sanitizer->sanitize(['elements' => $elements], 'front_elements', 'front');
    }

    public function test_it_accepts_an_empty_scene(): void
    {
        $scene = $this->sanitizer->sanitize([], 'back_elements', 'back');

        $this->assertSame([], $scene['elements']);
        $this->assertSame([], $scene['custom_fields']);
        $this->assertSame([], $scene['masks']);
        $this->assertSame(1, $scene['version']);
    }

    public function test_it_keeps_the_erased_regions_of_a_side(): void
    {
        $scene = $this->sanitizer->sanitize([
            'elements' => [$this->element()],
            'masks' => [
                ['id' => 'mk_name', 'left' => 40, 'top' => 120, 'width' => 300, 'height' => 44],
                ['id' => 'mk_photo', 'left' => 640, 'top' => 90, 'width' => 180, 'height' => 220],
            ],
        ], 'front_elements', 'front');

        $this->assertCount(2, $scene['masks']);
        $this->assertSame('mk_name', $scene['masks'][0]['id']);
        $this->assertSame(300.0, $scene['masks'][0]['width']);
        $this->assertSame('mk_photo', $scene['masks'][1]['id']);
        $this->assertSame(220.0, $scene['masks'][1]['height']);
    }

    public function test_it_rebuilds_masks_with_bounded_geometry(): void
    {
        $scene = $this->sanitizer->sanitize([
            'masks' => [
                ['id' => 'ok', 'left' => -99999, 'top' => -99999, 'width' => 99999, 'height' => 99999],
                ['id' => 'junk', 'left' => 'left', 'top' => null, 'width' => [], 'height' => 'tall'],
                'not an array',
                null,
            ],
        ], 'back_elements', 'back');

        $this->assertCount(2, $scene['masks']);

        // Off-card geometry is clamped rather than rejected, so a mask can never
        // push pixels outside the stored design.
        $this->assertSame(-20000.0, $scene['masks'][0]['left']);
        $this->assertSame(20000.0, $scene['masks'][0]['width']);

        // Values that are not numbers at all fall back to the defaults instead of
        // being passed through to the renderer.
        $this->assertSame(0.0, $scene['masks'][1]['left']);
        $this->assertSame(200.0, $scene['masks'][1]['width']);
        $this->assertSame(40.0, $scene['masks'][1]['height']);
    }

    public function test_it_keeps_the_layer_a_mask_was_cut_for(): void
    {
        $scene = $this->sanitizer->sanitize([
            'masks' => [
                ['id' => 'mk_name', 'left' => 40, 'top' => 120, 'width' => 300, 'height' => 44, 'elementId' => 'el_name'],
                ['id' => 'mk_photo', 'left' => 640, 'top' => 90, 'width' => 180, 'height' => 220, 'elementId' => 'el_photo'],
                // A hole cut by hand (Cover / Erase Area) belongs to no layer and
                // must stay that way, so deleting a layer never removes it.
                ['id' => 'mk_hand', 'left' => 10, 'top' => 10, 'width' => 20, 'height' => 20],
                ['id' => 'mk_odd', 'left' => 10, 'top' => 10, 'width' => 20, 'height' => 20, 'elementId' => '!!!'],
            ],
        ], 'front_elements', 'front');

        $this->assertSame('el_name', $scene['masks'][0]['elementId']);
        $this->assertSame('el_photo', $scene['masks'][1]['elementId']);
        $this->assertNull($scene['masks'][2]['elementId']);
        $this->assertNull($scene['masks'][3]['elementId']);
    }

    public function test_it_strips_unknown_keys_from_a_mask(): void
    {
        $scene = $this->sanitizer->sanitize([
            'masks' => [[
                'id' => 'mk_1',
                'left' => 10,
                'top' => 20,
                'width' => 30,
                'height' => 40,
                'elementId' => 'el_1',
                'src' => 'https://example.test/evil.png',
                'fill' => '#ff0000',
            ]],
        ], 'front_elements', 'front');

        $this->assertSame(['id', 'left', 'top', 'width', 'height', 'elementId'], array_keys($scene['masks'][0]));
        $this->assertSame('el_1', $scene['masks'][0]['elementId']);
    }

    public function test_it_caps_the_number_of_masks(): void
    {
        $masks = [];

        for ($i = 0; $i < 400; $i++) {
            $masks[] = ['id' => 'mk_'.$i, 'left' => 1, 'top' => 1, 'width' => 10, 'height' => 10];
        }

        $this->expectException(ValidationException::class);

        $this->sanitizer->sanitize(['masks' => $masks], 'front_elements', 'front');
    }
}