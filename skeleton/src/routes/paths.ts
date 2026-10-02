/**
 * Every in-app path used in more than one place (route, nav item, banner,
 * link) comes from here, so a rename cannot leave a dangling link.
 *
 * The configuration page is `/configuration`, never a path containing
 * "settings": the Cribl host shell intercepts those. The nav label may say
 * "Settings" and the KV key `settings` is fine; the route is not.
 */
export const PATHS = {
  overview: '/',
  configuration: '/configuration',
} as const;
