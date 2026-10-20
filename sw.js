// 캐시 우선(cache-first) 서비스 워커 + 웹 푸시(공지 알림) 수신
// 처음 한 번 정상적으로 방문하면, 그 이후로는 인터넷 연결이 끊기거나
// 사이트 자체가 없어져도 폰에 저장된 사본으로 계속 동작합니다.
//
// 나중에 앱 코드를 업데이트했다면, 아래 CACHE_NAME의 버전 숫자만 올려주세요
// (v1 -> v2). 그러면 각 폰이 다음에 인터넷에 연결된 상태로 열 때 새 버전을
// 통째로 다시 받아 저장합니다.

const CACHE_NAME = 'gunmupyo-cache-v4';

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key)) // 이전 버전 캐시 정리
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // 같은 사이트의 GET 요청만 캐시로 처리합니다.
  // (Firebase/Firestore 같은 외부 서버 통신이나 POST 요청은 건드리지 않고 그대로 통과)
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached; // 캐시에 있으면 네트워크 요청 없이 바로 응답 (오프라인 동작의 핵심)

      return fetch(event.request)
        .then((response) => {
          // 새로 받아온 리소스는 다음을 위해 캐시에 저장
          if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          }
          return response;
        })
        .catch(() => cached); // 네트워크도 안 되고 캐시도 없으면 실패 그대로 전달
    })
  );
});

/* ===================== 웹 푸시 (공지 알림) ===================== */

// 서버(GitHub Actions)가 보낸 푸시를 받아 팝업 알림으로 표시합니다. 앱이 닫혀 있어도 동작합니다.
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { body: event.data ? event.data.text() : '' };
  }
  // FCM 데이터 메시지는 { data: { title, body, ... } } 형태로 도착합니다.
  const d = payload.data || payload.notification || payload;

  const title = d.title || '기술국 근무 공지';
  const options = {
    body: d.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: d.tag || undefined,          // 같은 공지가 중복으로 쌓이지 않게 함
    requireInteraction: true,         // PC에서는 직접 닫을 때까지 유지 (모바일은 무시됨)
    data: { url: d.url || '' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// 알림을 누르면 앱을 열고 "공지" 탭으로 이동합니다.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = self.registration.scope + '#notice';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
          client.postMessage({ type: 'open-notice' });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
