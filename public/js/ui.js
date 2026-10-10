/* Comportamiento común del menú en tablet/celular */
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
})();
