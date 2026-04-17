self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_err) {
    payload = {};
  }

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(client => {
      client.postMessage({ type: 'appointment-push', payload });
    });

    const hasVisibleAdmin = clients.some(client =>
      client.url.includes('/admin') && client.visibilityState === 'visible'
    );
    if (hasVisibleAdmin) return;

    await self.registration.showNotification(payload.title || 'Yeni Randevu Talebi', {
      body: payload.body || 'Admin panelinde yeni bir randevu talebi var.',
      icon: '/serifkuraylogoc.png',
      badge: '/serifkuraylogoc.png',
      tag: payload.tag || 'appointment-notification',
      renotify: true,
      data: {
        url: payload.url || '/admin'
      }
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/admin';

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (client.url.includes('/admin')) {
        await client.focus();
        return;
      }
    }
    await self.clients.openWindow(targetUrl);
  })());
});
