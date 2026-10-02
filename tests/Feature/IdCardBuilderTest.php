<?php

namespace Tests\Feature;

use App\Models\IdCardTemplate;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Tests\TestCase;

class IdCardBuilderTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('public');
    }

    protected function scene(array $overrides = []): array
    {
        return array_merge([
            'version' => 1,
            'card' => ['width' => 1011, 'height' => 638, 'orientation' => 'landscape'],
            'background' => ['visible' => true, 'locked' => true],
            'custom_fields' => [['key' => 'guardian_name', 'label' => 'Guardian Name']],
            'masks' => [
                ['id' => 'mk_roll', 'left' => 120, 'top' => 240, 'width' => 200, 'height' => 40],
                ['id' => 'mk_cover', 'left' => 110, 'top' => 230, 'width' => 240, 'height' => 52],
            ],
            'elements' => [
                [
                    'id' => 'el_roll',
                    'name' => 'Roll Number',
                    'type' => 'dynamic_text',
                    'left' => 120,
                    'top' => 240,
                    'width' => 200,
                    'height' => 40,
                    'angle' => 0,
                    'opacity' => 1,
                    'visible' => true,
                    'locked' => false,
                    'text' => '',
                    'field' => 'roll',
                    'placeholder' => 'Roll Number',
                    'fontFamily' => 'Arial',
                    'fontSize' => 22,
                    'fontWeight' => 'bold',
                    'italic' => false,
                    'underline' => false,
                    'fill' => '#111111',
                    'textAlign' => 'left',
                    'lineHeight' => 1.2,
                    'letterSpacing' => 0,
                    'textTransform' => 'none',
                ],
                [
                    'id' => 'el_cover',
                    'name' => 'Cover / Erase Area',
                    'type' => 'cover',
                    'left' => 110,
                    'top' => 230,
                    'width' => 240,
                    'height' => 52,
                    'angle' => 0,
                    'opacity' => 1,
                    'visible' => true,
                    'locked' => false,
                    'bg' => '#ffffff',
                    'radius' => 4,
                    'strokeWidth' => 0,
                    'stroke' => '#000000',
                ],
            ],
        ], $overrides);
    }

    protected function storePayload(array $overrides = []): array
    {
        return array_merge([
            'name' => 'Modern School Student Card',
            'status' => 'active',
            'card_width' => 1011,
            'card_height' => 638,
            'orientation' => 'landscape',
            'front_elements' => json_encode($this->scene()),
            'back_elements' => json_encode($this->scene(['elements' => [], 'masks' => []])),
            'front_image' => UploadedFile::fake()->image('front.jpg', 1011, 638),
            'back_image' => UploadedFile::fake()->image('back.png', 1011, 638, 'png'),
        ], $overrides);
    }

    public function test_home_page_links_to_the_builder(): void
    {
        $this->get('/')
            ->assertOk()
            ->assertSee('ID Card Builder')
            ->assertSee(route('id-card-builder.index'), escape: false);
    }

    public function test_builder_page_renders_the_editor(): void
    {
        $response = $this->get('/id-card-builder');

        $response->assertOk();
        $response->assertSee('ID Card Builder', escape: false);
        $response->assertSee('idc-canvas', escape: false);
        $response->assertSee('Upload Front Design');
        $response->assertSee('Upload Back Design');
        $response->assertSee('Cover / Erase Area');
        $response->assertSee('Terms &amp; Conditions', escape: false);
        $response->assertSee('idc-config', escape: false);
    }

    public function test_builder_page_offers_the_editable_content_tools(): void
    {
        $response = $this->get('/id-card-builder');

        $response->assertSee('Make the Printed Content Editable');
        $response->assertSee('data-action="detect-regions"', escape: false);
        $response->assertSee('data-action="add-editable-text"', escape: false);
        $response->assertSee('data-action="restore-artwork"', escape: false);
        $response->assertSee('data-role="region-state"', escape: false);
    }

    public function test_builder_page_lists_every_dynamic_field(): void
    {
        $response = $this->get('/id-card-builder');

        foreach (['student_name', 'roll', 'blood_group', 'school_name', 'expiry_date', 'certificate_number'] as $key) {
            $response->assertSee('data-key="'.$key.'"', escape: false);
        }
    }

    public function test_store_requires_a_name_and_both_designs(): void
    {
        $this->post('/id-card-builder', [
            'front_elements' => json_encode($this->scene()),
            'back_elements' => json_encode($this->scene()),
        ])->assertSessionHasErrors(['name', 'front_image', 'back_image', 'card_width', 'card_height', 'orientation']);

        $this->assertDatabaseCount('id_card_templates', 0);
    }

    public function test_store_rejects_non_image_uploads(): void
    {
        $payload = $this->storePayload([
            'front_image' => UploadedFile::fake()->create('payload.php', 8, 'application/x-php'),
            'back_image' => UploadedFile::fake()->create('notes.txt', 8, 'text/plain'),
        ]);

        $this->post('/id-card-builder', $payload)
            ->assertSessionHasErrors(['front_image', 'back_image']);
    }

    public function test_store_rejects_a_backdoored_file_named_like_an_image(): void
    {
        $file = UploadedFile::fake()->create('evil.png', 8, 'image/png');

        $this->post('/id-card-builder', $this->storePayload(['front_image' => $file]))
            ->assertSessionHasErrors(['front_image']);
    }

    public function test_store_rejects_out_of_range_card_dimensions(): void
    {
        $this->post('/id-card-builder', $this->storePayload([
            'card_width' => 20,
            'card_height' => 99999,
        ]))->assertSessionHasErrors(['card_width', 'card_height']);
    }

    public function test_store_rejects_invalid_scene_json(): void
    {
        $this->post('/id-card-builder', $this->storePayload(['front_elements' => '{not json']))
            ->assertSessionHasErrors(['front_elements']);
    }

    public function test_store_saves_the_template_with_sanitised_elements(): void
    {
        $response = $this->post('/id-card-builder', $this->storePayload());

        $response->assertRedirect(route('template.index'));
        $response->assertSessionHas('status');

        $template = IdCardTemplate::firstOrFail();

        $this->assertSame('Modern School Student Card', $template->name);
        $this->assertSame(1011, $template->card_width);
        $this->assertSame(638, $template->card_height);
        $this->assertSame('landscape', $template->orientation);
        $this->assertSame('active', $template->status);
        $this->assertCount(2, $template->front_elements['elements']);
        $this->assertSame('roll', $template->front_elements['elements'][0]['field']);
        $this->assertSame('cover', $template->front_elements['elements'][1]['type']);
        $this->assertSame([['key' => 'guardian_name', 'label' => 'Guardian Name']], $template->front_elements['custom_fields']);
        $this->assertSame([], $template->back_elements['elements']);

        // The erased regions of the flat design travel with the scene, so a
        // reopened template never shows the original lettering behind the layers.
        $this->assertCount(2, $template->front_elements['masks']);
        $this->assertSame('mk_roll', $template->front_elements['masks'][0]['id']);
        $this->assertSame('mk_cover', $template->front_elements['masks'][1]['id']);
        $this->assertSame([], $template->back_elements['masks']);

        Storage::disk('public')->assertExists($template->front_image);
        Storage::disk('public')->assertExists($template->back_image);

        $this->assertStringStartsWith('id-card-builder/designs/front/', $template->front_image);
        $this->assertStringStartsWith('id-card-builder/designs/back/', $template->back_image);
        $this->assertStringEndsWith('.png', $template->back_image);
    }

    public function test_stored_design_file_is_byte_identical_to_the_upload(): void
    {
        $source = UploadedFile::fake()->image('front.jpg', 1011, 638);
        $expected = hash_file('sha256', $source->getRealPath());

        $this->post('/id-card-builder', $this->storePayload(['front_image' => $source]));

        $template = IdCardTemplate::firstOrFail();
        $stored = Storage::disk('public')->path($template->front_image);

        $this->assertFileExists($stored);
        $this->assertSame($expected, hash_file('sha256', $stored));
        $this->assertNotSame(basename($source->getClientOriginalName()), basename($template->front_image));
    }

    public function test_store_rejects_image_sources_that_were_not_uploaded_through_the_builder(): void
    {
        $scene = $this->scene();

        $scene['elements'][] = [
            'id' => 'el_evil',
            'name' => 'Remote image',
            'type' => 'image',
            'left' => 0,
            'top' => 0,
            'width' => 100,
            'height' => 100,
            'src' => 'https://example.com/tracker.png',
        ];

        $this->post('/id-card-builder', $this->storePayload(['front_elements' => json_encode($scene)]))
            ->assertSessionHasErrors('front_elements.elements.2.src');

        $this->assertDatabaseCount('id_card_templates', 0);
    }

    public function test_store_strips_unknown_element_keys_and_clamps_values(): void
    {
        $scene = $this->scene(['elements' => [[
            'id' => 'el_roll',
            'name' => 'Roll Number',
            'type' => 'dynamic_text',
            'left' => 999999,
            'top' => -50,
            'width' => 10 ** 9,
            'height' => 10 ** 9,
            'fontSize' => 5000,
            'opacity' => 4,
            'field' => 'ROLL NUMBER!',
            'fill' => 'url(javascript:alert(1))',
            'text' => str_repeat('a', 9000),
            'evil' => '<script>alert(1)</script>',
        ]]]);

        $this->post('/id-card-builder', $this->storePayload(['front_elements' => json_encode($scene)]));

        $element = IdCardTemplate::firstOrFail()->front_elements['elements'][0];

        $this->assertArrayNotHasKey('evil', $element);
        $this->assertEquals(20000, $element['left']);
        $this->assertEquals(-50, $element['top']);
        $this->assertEquals(20000, $element['width']);
        $this->assertEquals(400, $element['fontSize']);
        $this->assertEquals(1, $element['opacity']);
        $this->assertSame('roll_number', $element['field']);
        $this->assertSame('#000000', $element['fill']);
        $this->assertSame(4000, mb_strlen($element['text']));
    }

    public function test_asset_upload_returns_a_public_url(): void
    {
        $response = $this->post('/id-card-builder/assets', [
            'image' => UploadedFile::fake()->image('photo.png', 200, 200, 'png'),
            'kind' => 'photo',
        ]);

        $response->assertOk();

        $payload = $response->json();

        $this->assertStringStartsWith('id-card-builder/assets/photo/', $payload['path']);
        $this->assertStringContainsString('/storage/id-card-builder/assets/photo/', $payload['url']);
        $this->assertSame(200, $payload['width']);
        $this->assertSame(200, $payload['height']);

        Storage::disk('public')->assertExists($payload['path']);
    }

    public function test_asset_upload_validates_type_and_kind(): void
    {
        $this->post('/id-card-builder/assets', [
            'image' => UploadedFile::fake()->create('script.svg', 8, 'image/svg+xml'),
            'kind' => 'photo',
        ])->assertSessionHasErrors('image');

        $this->post('/id-card-builder/assets', [
            'image' => UploadedFile::fake()->image('photo.png', 100, 100, 'png'),
            'kind' => '../../escape',
        ])->assertSessionHasErrors('kind');
    }

    public function test_stored_element_image_can_be_referenced_in_a_scene(): void
    {
        $asset = $this->post('/id-card-builder/assets', [
            'image' => UploadedFile::fake()->image('logo.png', 120, 60, 'png'),
            'kind' => 'logo',
        ])->json();

        $scene = $this->scene(['elements' => [[
            'id' => 'el_logo',
            'name' => 'School Logo',
            'type' => 'image',
            'left' => 20,
            'top' => 20,
            'width' => 120,
            'height' => 60,
            'src' => $asset['url'],
            'fit' => 'contain',
            'frame' => 'none',
        ]]]);

        $this->post('/id-card-builder', $this->storePayload(['front_elements' => json_encode($scene)]))
            ->assertRedirect(route('template.index'));

        $element = IdCardTemplate::firstOrFail()->front_elements['elements'][0];

        $this->assertSame($asset['url'], $element['src']);
        $this->assertStringStartsWith('/storage/id-card-builder/assets/logo/', $element['src']);
    }

    public function test_an_absolute_image_url_is_stored_as_a_relative_storage_path(): void
    {
        $asset = $this->post('/id-card-builder/assets', [
            'image' => UploadedFile::fake()->image('logo.png', 120, 60, 'png'),
            'kind' => 'logo',
        ])->json();

        $scene = $this->scene(['elements' => [[
            'id' => 'el_logo',
            'name' => 'School Logo',
            'type' => 'image',
            'left' => 20,
            'top' => 20,
            'width' => 120,
            'height' => 60,
            'src' => 'http://localhost:8000'.Str::start($asset['url'], ''),
        ]]]);

        $this->post('/id-card-builder', $this->storePayload(['front_elements' => json_encode($scene)]))
            ->assertRedirect(route('template.index'));

        $this->assertSame($asset['url'], IdCardTemplate::firstOrFail()->front_elements['elements'][0]['src']);
    }

    public function test_a_deleted_asset_can_no_longer_be_referenced(): void
    {
        $asset = $this->post('/id-card-builder/assets', [
            'image' => UploadedFile::fake()->image('logo.png', 120, 60, 'png'),
            'kind' => 'logo',
        ])->json();

        Storage::disk('public')->delete($asset['path']);

        $scene = $this->scene(['elements' => [[
            'id' => 'el_logo',
            'name' => 'School Logo',
            'type' => 'image',
            'left' => 20,
            'top' => 20,
            'width' => 120,
            'height' => 60,
            'src' => $asset['url'],
        ]]]);

        $this->post('/id-card-builder', $this->storePayload(['front_elements' => json_encode($scene)]))
            ->assertSessionHasErrors('front_elements.elements.0.src');

        $this->assertDatabaseCount('id_card_templates', 0);
    }

    public function test_a_duplicate_layer_identifier_is_rejected(): void
    {
        $scene = $this->scene(['elements' => [$this->sceneElement('same'), $this->sceneElement('same')]]);

        $this->post('/id-card-builder', $this->storePayload(['front_elements' => json_encode($scene)]))
            ->assertSessionHasErrors('front_elements.elements.1.id');
    }

    public function test_an_unsupported_layer_type_is_rejected(): void
    {
        $scene = $this->scene(['elements' => [$this->sceneElement('el_1', ['type' => 'iframe'])]]);

        $this->post('/id-card-builder', $this->storePayload(['front_elements' => json_encode($scene)]))
            ->assertSessionHasErrors('front_elements.elements.0.type');
    }

    protected function sceneElement(string $id, array $overrides = []): array
    {
        return array_merge([
            'id' => $id,
            'name' => 'Student Name',
            'type' => 'dynamic_text',
            'left' => 100,
            'top' => 120,
            'width' => 300,
            'height' => 44,
            'field' => 'student_name',
            'fontSize' => 20,
        ], $overrides);
    }

    public function test_template_index_lists_saved_templates(): void
    {
        $this->post('/id-card-builder', $this->storePayload());

        $response = $this->get('/template');

        $response->assertOk();
        $response->assertSee('Modern School Student Card');
        $response->assertSee(route('id-card-builder.edit', IdCardTemplate::firstOrFail()), escape: false);
        $response->assertSee(route('template.preview', IdCardTemplate::firstOrFail()), escape: false);
    }

    public function test_edit_page_restores_the_saved_scene(): void
    {
        $this->post('/id-card-builder', $this->storePayload());
        $template = IdCardTemplate::firstOrFail();

        $response = $this->get("/id-card-builder/{$template->id}/edit");

        $response->assertOk();
        $response->assertSee('Save Changes');
        $response->assertSee('"templateId":'.$template->id, escape: false);
        $response->assertSee('"field":"roll"', escape: false);
        $response->assertSee('id-card-builder\/designs\/front\/', escape: false);
    }

    public function test_edit_page_hands_the_saved_masks_back_to_the_editor(): void
    {
        $this->post('/id-card-builder', $this->storePayload());

        $template = IdCardTemplate::firstOrFail();

        $response = $this->get("/id-card-builder/{$template->id}/edit");

        $response->assertOk();

        // The editor reloads the pristine design bitmap and re-applies these
        // rectangles, so the flattened content stays erased after a reload.
        $response->assertSee('"id":"mk_roll"', escape: false);
        $response->assertSee('"id":"mk_cover"', escape: false);
    }

    public function test_masks_can_be_cleared_to_bring_the_flattened_artwork_back(): void
    {
        $this->post('/id-card-builder', $this->storePayload());

        $template = IdCardTemplate::firstOrFail();
        $scene = $this->scene(['masks' => []]);

        $payload = $this->storePayload([
            '_method' => 'PUT',
            'front_elements' => json_encode($scene),
        ]);

        unset($payload['front_image'], $payload['back_image']);

        $this->put("/id-card-builder/{$template->id}", $payload)->assertRedirect(route('template.index'));

        $this->assertSame([], $template->refresh()->front_elements['masks']);
    }

    public function test_update_changes_the_template_in_place(): void
    {
        $this->post('/id-card-builder', $this->storePayload());
        $template = IdCardTemplate::firstOrFail();
        $originalFront = $template->front_image;

        $payload = $this->storePayload([
            'name' => 'Updated Card Name',
            'status' => 'draft',
            '_method' => 'PUT',
        ]);

        unset($payload['front_image'], $payload['back_image']);

        $response = $this->put("/id-card-builder/{$template->id}", $payload);

        $response->assertRedirect(route('template.index'));

        $template->refresh();

        $this->assertSame('Updated Card Name', $template->name);
        $this->assertSame('draft', $template->status);
        $this->assertSame($originalFront, $template->front_image);
        $this->assertDatabaseCount('id_card_templates', 1);

        Storage::disk('public')->assertExists($originalFront);
    }

    public function test_update_with_a_new_design_replaces_the_file_and_removes_the_old_one(): void
    {
        $this->post('/id-card-builder', $this->storePayload());
        $template = IdCardTemplate::firstOrFail();
        $oldFront = $template->front_image;

        $this->put("/id-card-builder/{$template->id}", [
            'name' => 'Replaced design',
            'front_image' => UploadedFile::fake()->image('new-front.jpg', 900, 500),
        ])->assertRedirect(route('template.index'));

        $template->refresh();

        $this->assertNotSame($oldFront, $template->front_image);
        Storage::disk('public')->assertExists($template->front_image);
        Storage::disk('public')->assertMissing($oldFront);
    }

    public function test_update_validates_the_name(): void
    {
        $this->post('/id-card-builder', $this->storePayload());
        $template = IdCardTemplate::firstOrFail();

        $this->put("/id-card-builder/{$template->id}", ['name' => ''])
            ->assertSessionHasErrors('name');

        $this->assertSame('Modern School Student Card', $template->refresh()->name);
    }

    public function test_save_as_new_creates_a_second_template_with_copied_designs(): void
    {
        $this->post('/id-card-builder', $this->storePayload());
        $source = IdCardTemplate::firstOrFail();

        $this->post('/id-card-builder', $this->storePayload([
            'name' => 'Second Card',
            '_copy_from' => $source->id,
        ]))->assertRedirect(route('template.index'));

        $this->assertDatabaseCount('id_card_templates', 2);

        $copy = IdCardTemplate::where('name', 'Second Card')->firstOrFail();

        $this->assertNotSame($source->front_image, $copy->front_image);
        Storage::disk('public')->assertExists($copy->front_image);
        Storage::disk('public')->assertExists($source->front_image);
    }

    public function test_save_as_new_with_only_one_replacement_keeps_both_designs(): void
    {
        $this->post('/id-card-builder', $this->storePayload());
        $source = IdCardTemplate::firstOrFail();

        $this->post('/id-card-builder', [
            'name' => 'Second Card',
            'status' => 'active',
            'card_width' => 600,
            'card_height' => 380,
            'orientation' => 'landscape',
            'front_elements' => json_encode($this->scene()),
            'back_elements' => json_encode($this->scene()),
            'front_image' => UploadedFile::fake()->image('new-front.jpg', 600, 380),
            '_copy_from' => $source->id,
        ])->assertRedirect(route('template.index'));

        $copy = IdCardTemplate::where('name', 'Second Card')->firstOrFail();

        $this->assertNotNull($copy->front_image);
        $this->assertNotNull($copy->back_image);
        Storage::disk('public')->assertExists($copy->front_image);
        Storage::disk('public')->assertExists($copy->back_image);

        // The replaced side is a new file, the untouched side is a copy.
        $this->assertNotSame($source->front_image, $copy->front_image);
        $this->assertNotSame($source->back_image, $copy->back_image);
        Storage::disk('public')->assertExists($source->front_image);
        Storage::disk('public')->assertExists($source->back_image);
    }

    public function test_preview_page_shows_both_sides(): void
    {
        $this->post('/id-card-builder', $this->storePayload());
        $template = IdCardTemplate::firstOrFail();

        $response = $this->get("/template/{$template->id}/preview");

        $response->assertOk();
        $response->assertSee('Front');
        $response->assertSee('Back');
        $response->assertSee(route('id-card-builder.edit', $template), escape: false);
    }

    public function test_destroy_requires_confirmation_and_removes_the_template_and_its_files(): void
    {
        $this->post('/id-card-builder', $this->storePayload());
        $template = IdCardTemplate::firstOrFail();
        $front = $template->front_image;
        $back = $template->back_image;

        $this->delete("/id-card-builder/{$template->id}")
            ->assertStatus(422);

        $this->assertDatabaseHas('id_card_templates', ['id' => $template->id]);

        $this->delete("/id-card-builder/{$template->id}", ['confirm' => 1])
            ->assertRedirect(route('template.index'));

        $this->assertDatabaseCount('id_card_templates', 0);
        Storage::disk('public')->assertMissing($front);
        Storage::disk('public')->assertMissing($back);
    }

    public function test_destroy_only_removes_files_owned_by_that_template(): void
    {
        $this->post('/id-card-builder', $this->storePayload());
        $first = IdCardTemplate::firstOrFail();

        $asset = $this->post('/id-card-builder/assets', [
            'image' => UploadedFile::fake()->image('signature.png', 150, 60, 'png'),
            'kind' => 'principal_signature',
        ])->json();

        $scene = $this->scene(['elements' => [[
            'id' => 'el_signature',
            'name' => 'Principal Signature',
            'type' => 'image',
            'left' => 700,
            'top' => 500,
            'width' => 150,
            'height' => 60,
            'src' => $asset['url'],
        ]]]);

        $this->post('/id-card-builder', $this->storePayload([
            'name' => 'Second card',
            'front_elements' => json_encode($scene),
        ]));

        $this->assertDatabaseCount('id_card_templates', 2);

        $this->delete("/id-card-builder/{$first->id}", ['confirm' => 1]);

        Storage::disk('public')->assertMissing($first->front_image);
        // The signature is still used by the second template.
        Storage::disk('public')->assertExists($asset['path']);
    }

    public function test_unknown_template_returns_404(): void
    {
        $this->get('/id-card-builder/999/edit')->assertNotFound();
        $this->get('/template/999/preview')->assertNotFound();
    }
}