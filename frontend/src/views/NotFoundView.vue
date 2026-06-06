<template>
  <div class="not-found">
    <EmptyState
      icon="Compass"
      title="Seite nicht gefunden"
      description="Die angeforderte Seite existiert nicht."
      action-to="/"
      action-label="Zum Dashboard"
    />
  </div>
</template>

<script setup lang="ts">
import EmptyState from '../components/EmptyState.vue';
</script>
