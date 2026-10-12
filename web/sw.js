// islands service worker: push notifications, nothing else (item 23).
//
// No fetch handler and no cache on purpose. The app is served no-cache so a
// deploy reaches everyone on the next load; a caching worker would hand out
// yesterday's JavaScript instead, and offline the map has nothing to show.
//
// Served from / (app.py) so its scope covers the whole app, always revalidated
// so an update here is picked up on the next visit.

const ICON = '/static/img/icons/icon-192.png';
const BADGE = '/static/img/icons/badge-96.png';
const HOME = '/#/notifications';

// Safari (iPhone, iPad, Mac) withdraws the subscription of a site whose push
// shows nothing, so there every push is shown even with the app in front.
const WEBKIT = /AppleWebKit/.test(self.navigator.userAgent)
  && !/Chrome\/|Chromium\/|Edg\//.test(self.navigator.userAgent);

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function read(event) {
  if (!event.data) return {};
  try {
    return event.data.json();
  } catch {
    return { body: event.data.text() };
  }
}

async function windows() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
}

self.addEventListener('push', (event) => {
  const message = read(event);
  event.waitUntil((async () => {
    const open = await windows();
    // Any open window reads the list again at once instead of in 30 seconds.
    open.forEach((client) => client.postMessage({ type: 'refresh' }));
    // In front and looked at: the band inside the app says it already.
    const watched = open.some((client) => client.focused && client.visibilityState === 'visible');
    if (watched && !WEBKIT) return;
    await self.registration.showNotification(message.title || 'islands', {
      body: message.body || '',
      tag: message.tag || undefined,
      renotify: Boolean(message.tag),
      icon: ICON,
      badge: BADGE,
      lang: 'ja',
      timestamp: message.at ? Date.parse(message.at) || Date.now() : Date.now(),
      data: { url: message.url || HOME },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data || {}).url || HOME, self.location.origin).href;
  event.waitUntil((async () => {
    const open = await windows();
    const mine = open.find((client) => new URL(client.url).origin === self.location.origin);
    if (mine) {
      mine.postMessage({ type: 'open', url });
      try {
        await mine.focus();
        return;
      } catch {
        // Some browsers refuse focus(); a new window still gets there.
      }
    }
    await self.clients.openWindow(url);
  })());
});
