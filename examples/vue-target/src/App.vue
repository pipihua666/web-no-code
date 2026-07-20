<script setup lang="ts">
const stats = [
  { label: "Selected nodes", value: "18" },
  { label: "Style patches", value: "42" },
  { label: "Image swaps", value: "7" }
];
</script>

<template>
  <main class="page-shell">
    <section class="hero-panel">
      <div class="hero-copy">
        <p class="eyebrow">Local Vite target</p>
        <h1>Canvas page for visual editing</h1>
        <p class="summary">
          Pick any element from the parent editor, inspect CSS, preview edits, then confirm source writes.
        </p>
        <button class="primary-action">Inspect this button</button>
      </div>
      <div class="artifact-card">
        <div class="card-topline"></div>
        <div class="mock-window">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <strong>HeroCard.vue</strong>
        <p>Background, radius, spacing, type and image rules are intentionally editable.</p>
      </div>
    </section>

    <section class="stats-row">
      <article v-for="item in stats" :key="item.label" class="stat-tile">
        <span>{{ item.label }}</span>
        <strong>{{ item.value }}</strong>
      </article>
    </section>
  </main>
</template>
