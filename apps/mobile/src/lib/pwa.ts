// Web app (PWA) hooks. Native builds have nothing to install; the web build uses pwa.web.ts.
export const useInstall = () => ({ canInstall: false, iosHint: false, install: async () => {}, dismissHint: () => {} });
