/* Comportamiento común: menú en tablet/celular, instalación como app y servicio sin conexión */
(function () {
    function menu() { return document.querySelector('.sidebar'); }

    // Tocar fuera del menú lo cierra
    document.addEventListener('click', function (e) {
        const m = menu();
        if (!m || !m.classList.contains('active')) return;
        if (e.target.closest('.sidebar') || e.target.closest('.menu-toggle-btn')) return;
        m.classList.remove('active');
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && menu()) menu().classList.remove('active');
    });

    // ---------- Servicio sin conexión (solo la pantalla de Buscar guarda una copia) ----------
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('/sw.js').catch(function () { /* sin servicio: la web funciona igual */ });
        });
    }

    // ---------- Botón "Instalar app" (Android / Chrome) ----------
    let aviso = null;
    window.addEventListener('beforeinstallprompt', function (e) {
        e.preventDefault();
        aviso = e;
        const lista = document.querySelector('.sidebar-menu');
        if (!lista || document.getElementById('btnInstalar')) return;
        const li = document.createElement('li');
        li.innerHTML = '<a href="#" id="btnInstalar"><i class="fa-solid fa-mobile-screen-button"></i> Instalar app</a>';
        const salir = lista.querySelector('li:last-child');
        lista.insertBefore(li, salir);
        li.querySelector('a').addEventListener('click', function (ev) {
            ev.preventDefault();
            if (!aviso) return;
            aviso.prompt();
            aviso.userChoice.finally(function () { aviso = null; li.remove(); });
        });
    });
    window.addEventListener('appinstalled', function () {
        const b = document.getElementById('btnInstalar');
        if (b) b.parentElement.remove();
    });
})();
