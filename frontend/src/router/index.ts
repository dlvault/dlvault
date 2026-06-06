import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'dashboard',
      component: () => import('../views/DashboardView.vue'),
      meta: { title: 'Dashboard' },
    },
    {
      path: '/movies',
      name: 'movies',
      component: () => import('../views/MoviesView.vue'),
      meta: { title: 'Warteschlange' },
    },
    {
      path: '/library',
      name: 'library',
      component: () => import('../views/LibraryView.vue'),
      meta: { title: 'Mediathek' },
    },
    {
      path: '/downloads',
      name: 'downloads',
      component: () => import('../views/DownloadsView.vue'),
      meta: { title: 'Downloads' },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('../views/SettingsView.vue'),
      meta: { title: 'Einstellungen' },
    },
    {
      path: '/logs',
      name: 'logs',
      component: () => import('../views/LogsView.vue'),
      meta: { title: 'Logs' },
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('../views/NotFoundView.vue'),
      meta: { title: 'Nicht gefunden' },
    },
  ],
});

router.beforeEach((to) => {
  const title = to.meta.title as string | undefined;
  document.title = title ? `${title} - dlvault` : 'dlvault';
});

export default router;
