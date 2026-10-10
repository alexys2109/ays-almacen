/* Servicio de la app (se sirve en /sw.js).
   - Guarda una copia de la pantalla "Buscar productos" para poder consultar precios sin internet (emergencias).
   - Guarda los archivos de diseño para que cargue más rápido.
   - Las demás pantallas (modificar, agregar, eliminar...) siempre necesitan internet. */
const VER = '__VER__';
const C_ESTATICO = 'ays-static-' + VER;
const C_PAGINAS = 'ays-pages';        // copia de la pantalla Buscar (se borra al cerrar sesión)
const PRECACHE = [
    '/offline.html',
    '/css/dashboard.css?v=' + VER,
    '/js/similitud.js?v=' + VER,
    '/js/frescura.js?v=' + VER,
    '/js/ui.js?v=' + VER,
    '/vendor/bootstrap/bootstrap.min.css?v=1',
    '/vendor/fontawesome/css/all.min.css?v=1',
    '/vendor/fontawesome/webfonts/fa-solid-900.woff2',
    '/vendor/fontawesome/webfonts/fa-regular-400.woff2',
    '/vendor/nprogress/nprogress.js?v=1',
    '/vendor/nprogress/nprogress.css?v=1',
    '/vendor/fonts/inter-latin.woff2',
    '/img/logo-ays.png',
    '/img/icon-192.png'
];

self.addEventListener('install', function (e) {
    e.waitUntil(
        caches.open(C_ESTATICO).then(function (c) {
            // cada archivo por separado: si uno falla, los demás igual se guardan
            return Promise.all(PRECACHE.map(function (u) { return c.add(u).catch(function () { }); }));
        }).then(function () { return self.skipWaiting(); })
    );
});

self.addEventListener('activate', function (e) {
    e.waitUntil(
        caches.keys().then(function (claves) {
            return Promise.all(claves.filter(function (k) { return k !== C_ESTATICO && k !== C_PAGINAS; }).map(function (k) { return caches.delete(k); }));
        }).then(function () { return self.clients.claim(); })
    );
});

// Marca la copia guardada para que la pantalla avise "estás sin conexión"
function conAvisoSinConexion(resp) {
    return resp.text().then(function (html) {
        return new Response(html.replace('</head>', '<script>window.__MODO_OFFLINE=true;</script></head>'), {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
    });
}

function esperar(ms) { return new Promise(function (r) { setTimeout(function () { r(null); }, ms); }); }

function pantallaBuscar(req) {
    const intento = fetch(req).then(function (resp) {
        // solo se guarda si es la página real (no una redirección al login)
        const tipo = resp.headers.get('content-type') || '';
        if (resp.ok && !resp.redirected && /text\/html/.test(tipo)) {
            const copia = resp.clone();
            caches.open(C_PAGINAS).then(function (c) { c.put('/', copia); });
        }
        return resp;
    });
    // Con internet normal responde enseguida; si no hay red (o es muy lenta) usa la copia guardada
    return Promise.race([intento, esperar(7000)]).then(function (resp) {
        if (resp) return resp;
        return caches.open(C_PAGINAS).then(function (c) { return c.match('/'); }).then(function (g) {
            return g ? conAvisoSinConexion(g) : intento;
        });
    }).catch(function () {
        return caches.open(C_PAGINAS).then(function (c) { return c.match('/'); }).then(function (g) {
            if (g) return conAvisoSinConexion(g);
            return caches.match('/offline.html');
        });
    });
}

self.addEventListener('fetch', function (e) {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    // Páginas de la app
    if (url.origin === self.location.origin && req.mode === 'navigate') {
        if (url.pathname === '/') { e.respondWith(pantallaBuscar(req)); return; }
        // el resto de pantallas necesita internet: si no hay, se muestra el aviso
        e.respondWith(fetch(req).catch(function () { return caches.match('/offline.html'); }));
        return;
    }

    // Datos y acciones del servidor: nunca se guardan
    if (url.origin === self.location.origin && (/^\/(api|login|logout|modificar|agregar|eliminar|duplicados|lista|salud|sw\.js)/.test(url.pathname))) return;

    // Archivos de diseño (propios y de CDN): primero lo guardado, y se actualiza en segundo plano
    const destino = req.destination;
    if (['style', 'script', 'font', 'image'].indexOf(destino) !== -1 || url.pathname === '/manifest.webmanifest') {
        e.respondWith(
            caches.open(C_ESTATICO).then(function (c) {
                return c.match(req).then(function (guardado) {
                    const red = fetch(req).then(function (resp) {
                        if (resp && (resp.ok || resp.type === 'opaque')) { try { c.put(req, resp.clone()); } catch (err) { } }
                        return resp;
                    }).catch(function () { return guardado; });
                    return guardado || red;
                });
            })
        );
    }
});
