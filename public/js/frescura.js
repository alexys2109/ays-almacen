/* Frescura del precio: cuánto hace que se cambió o confirmó, con su bolita de color.
   Funciona en el navegador (window.Frescura) y en Node (require). */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.Frescura = factory();
})(typeof self !== 'undefined' ? self : this, function () {

    const DIA = 86400;
    // Rangos de la bolita (en días). Se pueden ajustar aquí.
    const RANGOS = [
        { hasta: 7,        clase: 'verde',    nombre: 'Reciente' },
        { hasta: 30,       clase: 'amarillo', nombre: 'Revisar pronto' },
        { hasta: 60,       clase: 'naranja',  nombre: 'Desactualizado' },
        { hasta: Infinity, clase: 'rojo',     nombre: 'Muy desactualizado' }
    ];

    function esNum(v) { return v !== null && v !== undefined && v !== '' && !isNaN(Number(v)); }

    // Segundos desde la última vez que el precio se cambió o se confirmó (null si nunca)
    function segundosPrecio(p) {
        const a = esNum(p.seg_cambio) ? Math.max(0, Number(p.seg_cambio)) : null;
        const b = esNum(p.seg_confirmado) ? Math.max(0, Number(p.seg_confirmado)) : null;
        if (a === null) return b;
        if (b === null) return a;
        return Math.min(a, b);
    }

    function rango(seg) {
        if (seg === null) return RANGOS[RANGOS.length - 1];
        const dias = seg / DIA;
        for (let i = 0; i < RANGOS.length; i++) if (dias <= RANGOS[i].hasta) return RANGOS[i];
        return RANGOS[RANGOS.length - 1];
    }

    function hace(seg) {
        if (seg === null) return 'sin fecha';
        if (seg < 60) return 'hace un momento';
        const min = Math.floor(seg / 60);
        if (min < 60) return 'hace ' + min + ' min';
        const h = Math.floor(min / 60);
        if (h < 24) return 'hace ' + h + (h === 1 ? ' hora' : ' horas');
        const d = Math.floor(h / 24);
        if (d === 1) return 'ayer';
        if (d < 14) return 'hace ' + d + ' días';
        if (d < 60) return 'hace ' + Math.floor(d / 7) + ' semanas';
        if (d < 365) { const m = Math.floor(d / 30); return 'hace ' + m + (m === 1 ? ' mes' : ' meses'); }
        return 'hace más de un año';
    }

    function fecha(seg) {
        if (seg === null) return '—';
        return new Date(Date.now() - seg * 1000).toLocaleDateString('es-PE', {
            day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Lima'
        });
    }

    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // Texto de ayuda (tooltip) con las dos fechas
    function detalle(p) {
        const c = esNum(p.seg_cambio) ? Number(p.seg_cambio) : null;
        const f = esNum(p.seg_confirmado) ? Number(p.seg_confirmado) : null;
        let t = 'Precio cambiado: ' + (c === null ? 'sin registro' : fecha(c) + ' (' + hace(c) + ')');
        t += ' · Confirmado: ' + (f === null ? 'nunca' : fecha(f) + ' (' + hace(f) + ')');
        return t;
    }

    // HTML de la bolita + fecha + "hace X"
    function insignia(p) {
        const seg = segundosPrecio(p);
        const r = rango(seg);
        return '<span class="frescura frescura-' + r.clase + '" title="' + esc(r.nombre + ' — ' + detalle(p)) + '">' +
            '<span class="dot-frescura dot-' + r.clase + '"></span>' +
            '<span class="frescura-texto"><b>' + fecha(seg) + '</b><small>' + hace(seg) + '</small></span></span>';
    }

    return { RANGOS: RANGOS, segundosPrecio: segundosPrecio, rango: rango, hace: hace, fecha: fecha, detalle: detalle, insignia: insignia, esc: esc };
});
