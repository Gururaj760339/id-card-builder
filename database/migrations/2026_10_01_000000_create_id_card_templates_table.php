<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::create('id_card_templates', function (Blueprint $table) {
            $table->id();
            $table->string('name', 150);
            $table->string('front_image')->nullable();
            $table->string('back_image')->nullable();
            $table->json('front_elements')->nullable();
            $table->json('back_elements')->nullable();
            $table->unsignedInteger('card_width')->default(1011);
            $table->unsignedInteger('card_height')->default(638);
            $table->string('orientation', 20)->default('landscape');
            $table->string('status', 20)->default('active');
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();

            $table->index('status');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('id_card_templates');
    }
};