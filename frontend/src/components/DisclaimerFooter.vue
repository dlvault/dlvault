<template>
  <div class="disclaimer-footer" role="contentinfo">
    <strong>dlvault</strong> is a generic media-library orchestrator.
    Plugins are <em>third-party code</em> installed at the user's discretion
    and risk. The maintainers do not endorse or curate any plugin.
    Users are responsible for ensuring their use complies with applicable
    copyright, licensing, and terms-of-service agreements.
    &nbsp;·&nbsp;
    <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener">AGPL-3.0</a>
  </div>
</template>

<style scoped>
.disclaimer-footer {
  margin-top: 32px;
  padding: 16px 20px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--color-text-secondary, #888);
  background: rgba(0, 0, 0, 0.15);
  border-top: 1px solid var(--color-border, rgba(255, 255, 255, 0.05));
  border-radius: 4px;
  text-align: center;
}
.disclaimer-footer a {
  color: inherit;
  text-decoration: underline;
}
.disclaimer-footer strong {
  font-weight: 600;
}
.disclaimer-footer em {
  font-style: italic;
}
</style>
