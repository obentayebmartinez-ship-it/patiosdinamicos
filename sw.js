/* Service worker de Patios Dinámicos.
   IMPORTANTE: al publicar cualquier cambio en index.html o en lib/,
   subir el número de VERSION para que los dispositivos se actualicen. */
const VERSION = 'patios-v13';

const APP_SHELL = [
  './',
  'index.html',
  'manifest.json',
  'icono-192.png',
  'icono-512.png',
  'lib/leaflet.css',
  'lib/leaflet.js',
  'lib/leaflet.draw.css',
  'lib/leaflet.draw.js',
  'lib/leaflet-rotate.js',
  'lib/turf.min.js',
  'lib/supabase.js',
  'lib/images/layers.png',
  'lib/images/layers-2x.png',
  'lib/images/marker-icon.png',
  'lib/images/marker-icon-2x.png',
  'lib/images/marker-shadow.png',
  'lib/images/spritesheet.png',
  'lib/images/spritesheet-2x.png',
  'lib/images/spritesheet.svg',
  'lib/fonts/baloo2.woff2',
  'lib/fonts/atkinson-400.woff2',
  'lib/fonts/atkinson-700.woff2',
  'lib/fonts/atkinson-400i.woff2'
];

self.addEventListener('install', e => {
  // cache:'reload' salta la caché HTTP del navegador: sin ella podríamos
  // guardar en el app shell una versión rancia (el servidor de desarrollo
  // de Python no manda cabeceras de caché)
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(APP_SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(claves => Promise.all(claves.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Teselas de mapa, Overpass, Nominatim…: solo red; si falla, falla (la app sigue viva)
  if (url.origin !== location.origin) return;

  // La página se sirve red-primero (para recibir versiones nuevas), con caché de
  // respaldo. cache:'no-store' evita que la caché HTTP devuelva un HTML rancio.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(r => { const copia = r.clone(); caches.open(VERSION).then(c => c.put('index.html', copia)); return r; })
        .catch(() => caches.match('index.html'))
    );
    return;
  }

  // Resto del app shell: caché-primero (librerías y fuentes no cambian sin subir VERSION)
  e.respondWith(
    caches.match(e.request).then(en => en || fetch(e.request).then(r => {
      const copia = r.clone();
      caches.open(VERSION).then(c => c.put(e.request, copia));
      return r;
    }))
  );
});
