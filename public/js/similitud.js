/* Búsqueda tolerante a errores y comparación de nombres de productos.
   Funciona en el navegador (window.Similitud) y en Node (require). */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.Similitud = factory();
})(typeof self !== 'undefined' ? self : this, function () {

    // ---------- Normalización ----------
    // Palabras de relleno y unidades: no sirven para decidir si dos productos son el mismo
    const RELLENO = { de: 1, la: 1, el: 1, los: 1, las: 1, y: 1, con: 1, para: 1, en: 1, x: 1, g: 1, gr: 1, kg: 1, k: 1, l: 1, lt: 1, lts: 1, ml: 1, oz: 1, und: 1, un: 1, unid: 1, pqt: 1, paq: 1, caja: 1 };

    function limpiar(s) {
        return String(s == null ? '' : s).toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '') // sin tildes (ñ -> n)
            .replace(/(\d)[.,](\d)/g, '$1_$2')               // 4.2 -> 4_2 (un solo número)
            .replace(/[^a-z0-9_]+/g, ' ')
            .replace(/(\d)([a-z])/g, '$1 $2')   // 45g -> 45 g
            .replace(/([a-z])(\d)/g, '$1 $2')   // x10 -> x 10
            .trim();
    }

    // Aproxima cómo SUENA la palabra en español (cemola = semola, vazo = baso, marcella = marsella)
    function fonetico(w) {
        w = w.replace(/ch/g, '#').replace(/h/g, '')
            .replace(/ll/g, 'y')
            .replace(/qu(?=[ei])/g, 'k').replace(/q/g, 'k')
            .replace(/gu(?=[ei])/g, 'g')
            .replace(/c(?=[ei])/g, 's').replace(/c/g, 'k')
            .replace(/g(?=[ei])/g, 'j')
            .replace(/[zs]/g, 's').replace(/[vw]/g, 'b')
            .replace(/x/g, 'ks')
            .replace(/(.)\1+/g, '$1');
        if (w.length > 3 && w.charAt(w.length - 1) === 's') w = w.slice(0, -1); // plural
        return w;
    }

    function preparar(nombre) {
        return limpiar(nombre).split(' ').filter(Boolean).map(function (t) {
            const num = /^\d+(_\d+)*$/.test(t);
            return { t: t, f: num ? t : fonetico(t), num: num, relleno: !num && !!RELLENO[t] };
        });
    }

    // ---------- Distancia de edición (Damerau-Levenshtein) ----------
    function distancia(a, b) {
        const la = a.length, lb = b.length;
        if (a === b) return 0;
        if (!la) return lb;
        if (!lb) return la;
        let prev2 = null, prev = [], cur = [];
        for (let j = 0; j <= lb; j++) prev[j] = j;
        for (let i = 1; i <= la; i++) {
            cur = [i];
            for (let j = 1; j <= lb; j++) {
                const costo = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
                let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + costo);
                if (i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
                    v = Math.min(v, prev2[j - 2] + 1); // letras intercambiadas
                }
                cur[j] = v;
            }
            prev2 = prev; prev = cur;
        }
        return prev[lb];
    }

    function toleranciaEdicion(a, b) {
        const m = Math.max(a.length, b.length);
        return m <= 4 ? 0 : (m <= 7 ? 1 : 2);
    }

    // Memoria de comparaciones entre palabras: el vocabulario se repite mucho, así que casi todo se calcula una vez
    const memoPalabras = new Map();

    // ---------- Parecido entre dos palabras (0..1) ----------
    // modoBusqueda: la palabra A se está escribiendo, así que puede ser solo el comienzo de B.
    function simPalabra(a, b, modoBusqueda, minPrefijo) {
        if (modoBusqueda) return calcPalabra(a, b, modoBusqueda, minPrefijo);
        const clave = a.t + '' + b.t;
        let v = memoPalabras.get(clave);
        if (v === undefined) {
            v = calcPalabra(a, b, false);
            if (memoPalabras.size > 300000) memoPalabras.clear();
            memoPalabras.set(clave, v);
        }
        return v;
    }

    function calcPalabra(a, b, modoBusqueda, minPrefijo) {
        if (a.num || b.num) {
            if (a.t === b.t) return 1;
            if (modoBusqueda && a.num && b.num && b.t.indexOf(a.t) === 0) return 0.75; // escribiendo "45" -> 450
            return 0;
        }
        if (a.t === b.t) return 1;
        // Distancia de escritura real: evita que letras repetidas/raras se "colapsen" y coincidan con todo
        if (!modoBusqueda && Math.abs(a.f.length - b.f.length) > 2 && Math.abs(a.t.length - b.t.length) > 2) return 0;
        let rawCache = -1;
        const rawDist = function () { if (rawCache < 0) rawCache = distancia(a.t, b.t); return rawCache; };
        if (a.f === b.f && a.f.length >= 2 && rawDist() <= 3) return 0.95;
        if (modoBusqueda) {
            const mp = minPrefijo || 2;
            if (a.t.length >= mp && b.t.indexOf(a.t) === 0) return 0.92;
            if (a.f.length >= mp && b.f.indexOf(a.f) === 0) return 0.88;
            if (a.t.length >= 3 && b.t.indexOf(a.t) > 0) return 0.7;
            // error de escritura dentro del comienzo de la palabra (sonido o escritura tal cual)
            if (a.f.length >= 5) {
                const trozo = b.f.slice(0, a.f.length);
                if (distancia(a.f, trozo) <= 1 && distancia(a.t, b.t.slice(0, a.t.length)) <= 2) return 0.78;
            }
            if (a.t.length >= 5 && distancia(a.t, b.t.slice(0, a.t.length)) <= 1) return 0.76;
        }
        let mejor = 0;
        if (Math.abs(a.f.length - b.f.length) <= 2) {
            const d = distancia(a.f, b.f);
            if (d <= toleranciaEdicion(a.f, b.f) && rawDist() <= toleranciaEdicion(a.f, b.f) + 1) mejor = d === 1 ? 0.8 : 0.65;
        }
        // Mismo chequeo con las letras tal como se escribieron (cubre letras faltantes o intercambiadas)
        if (!mejor && Math.abs(a.t.length - b.t.length) <= 2) {
            const d = distancia(a.t, b.t);
            if (d <= toleranciaEdicion(a.t, b.t)) mejor = d === 1 ? 0.78 : 0.62;
        }
        // Palabras cortas con dos letras intercambiadas (vela/veal, poet/pote)
        if (!mejor && a.t.length >= 3 && a.t.length <= 4 && a.t.length === b.t.length &&
            a.t.split('').sort().join('') === b.t.split('').sort().join('') && distancia(a.t, b.t) === 1) mejor = 0.7;
        return mejor;
    }

    // ---------- Búsqueda ----------
    function indexar(items, campo) {
        campo = campo || 'nombre';
        return items.map(function (item) { return { item: item, toks: preparar(item[campo]) }; });
    }

    // Devuelve [{item, score}] ordenado de más a menos parecido. Sin consulta -> todos.
    function buscar(consulta, indice, opciones) {
        opciones = opciones || {};
        const q = preparar(consulta);
        if (!q.length) return indice.map(function (e) { return { item: e.item, score: 1 }; });
        const res = [];
        for (let i = 0; i < indice.length; i++) {
            const e = indice[i];
            let suma = 0, ok = true;
            for (let k = 0; k < q.length; k++) {
                let mejor = 0;
                for (let j = 0; j < e.toks.length; j++) {
                    const s = simPalabra(q[k], e.toks[j], true, opciones.minPrefijo);
                    if (s > mejor) mejor = s;
                    if (mejor === 1) break;
                }
                if (mejor === 0) { ok = false; break; }
                suma += mejor;
            }
            if (!ok) continue;
            let score = suma / q.length;
            score -= Math.max(0, e.toks.length - q.length) * 0.01; // nombres más cortos primero
            res.push({ item: e.item, score: score });
        }
        res.sort(function (a, b) {
            return b.score - a.score || String(a.item.nombre).localeCompare(String(b.item.nombre), 'es');
        });
        return res;
    }

    // ---------- Comparación completa de dos nombres (0..1), para duplicados ----------
    function direccion(A, B) {
        let s = 0;
        for (let i = 0; i < A.length; i++) {
            let mejor = 0;
            for (let j = 0; j < B.length; j++) {
                const v = simPalabra(A[i], B[j], false);
                if (v > mejor) mejor = v;
            }
            s += mejor;
        }
        return s / A.length;
    }

    // Datos derivados de un nombre (se calculan una sola vez y quedan en el propio arreglo)
    function derivados(A) {
        if (!A._w) {
            const w = A.filter(function (t) { return !t.num && !t.relleno; });
            A._w = w.length ? w : A;
            A._n = A.filter(function (t) { return t.num; }).map(function (t) { return t.t; }).sort().join(',');
        }
        return A;
    }

    // Un nombre es "casi el mismo" que otro cuando todas sus palabras clave (mínimo 2) están en el otro
    // (aunque sea con un error de escritura) y el otro solo agrega 1 o 2 palabras. Ej: "saplio mosca x12" ~ "sapolio spray mosca x12".
    function esSubconjunto(A, B) {
        const chico = A._w.length <= B._w.length ? A : B;
        const grande = chico === A ? B : A;
        const ws = chico._w, wl = grande._w;
        if (ws === chico || wl === grande) return false;          // alguno no tiene palabras clave
        if (ws.length < 2 || wl.length - ws.length > 2) return false;
        if (chico._n && grande._n && chico._n !== grande._n) return false;   // tamaños distintos = productos distintos
        for (let i = 0; i < ws.length; i++) {
            let mejor = 0;
            for (let j = 0; j < wl.length; j++) {
                const v = simPalabra(ws[i], wl[j], false);
                if (v > mejor) mejor = v;
            }
            if (mejor < 0.75) return false;
        }
        return true;
    }

    function similitud(A, B) {
        if (!A.length || !B.length) return 0;
        derivados(A); derivados(B);
        // Se comparan las palabras clave (sin números ni unidades). Los números solo ajustan el resultado.
        let wA = A._w, wB = B._w;
        if (wA === A !== (wB === B)) { wA = A; wB = B; }   // si solo uno tiene palabras clave, se usan todas
        let base = (direccion(wA, wB) + direccion(wB, wA)) / 2;
        const nA = A._n, nB = B._n;
        if (nA && nB && nA !== nB) base *= 0.6;      // 45g vs 90g: probablemente son productos distintos
        else if ((nA && !nB) || (!nA && nB)) base *= 0.92;
        if (base < 0.82 && esSubconjunto(A, B)) base = 0.82;
        return base;
    }

    // Productos que podrían ser el mismo que "nombre" (para avisar al agregar)
    function parecidos(nombre, indice, opciones) {
        opciones = opciones || {};
        const A = preparar(nombre);
        if (!A.length) return [];
        const minimo = opciones.minimo || 0.62;
        const porBusqueda = {};
        buscar(nombre, indice, { minPrefijo: 3 }).forEach(function (r) { porBusqueda[r.item.id] = r.score; });
        const res = [];
        for (let i = 0; i < indice.length; i++) {
            const e = indice[i];
            const s1 = similitud(A, e.toks);
            const s2 = porBusqueda[e.item.id] || 0;
            // la búsqueda solo cuenta si lo escrito está casi completo en el producto existente
            const score = Math.max(s1, s2 >= 0.9 ? s2 * 0.85 : 0);
            if (score >= minimo) res.push({ item: e.item, score: score });
        }
        res.sort(function (a, b) { return b.score - a.score; });
        return res.slice(0, opciones.max || 8);
    }

    // Agrupa productos casi iguales. Devuelve [{ items:[...], score }] (grupos de 2 o más).
    function agruparDuplicados(items, umbral) {
        umbral = umbral || 0.8;
        const ind = indexar(items);
        const n = ind.length;
        const padre = [];
        for (let i = 0; i < n; i++) padre[i] = i;
        const raiz = function (x) { while (padre[x] !== x) { padre[x] = padre[padre[x]]; x = padre[x]; } return x; };
        // Solo se comparan productos que comparten las 3 primeras letras (fonéticas) de alguna palabra clave
        const cubetas = {};
        ind.forEach(function (e, i) {
            const vistas = {};
            e.toks.forEach(function (t) {
                if (t.num || t.relleno) return;
                const c = t.f.slice(0, 3);
                if (!vistas[c]) { vistas[c] = true; (cubetas[c] = cubetas[c] || []).push(i); }
            });
        });
        const comparados = {};
        const mejorPar = {};
        Object.keys(cubetas).forEach(function (c) {
            const lista = cubetas[c];
            for (let x = 0; x < lista.length; x++) {
                for (let y = x + 1; y < lista.length; y++) {
                    const i = lista[x], j = lista[y];
                    const clave = i * n + j;
                    if (comparados[clave]) continue;
                    comparados[clave] = true;
                    const s = similitud(ind[i].toks, ind[j].toks);
                    if (s >= umbral) {
                        padre[raiz(i)] = raiz(j);
                        mejorPar[i] = Math.max(mejorPar[i] || 0, s);
                        mejorPar[j] = Math.max(mejorPar[j] || 0, s);
                    }
                }
            }
        });
        const grupos = {};
        for (let i = 0; i < n; i++) {
            if (mejorPar[i] === undefined) continue;
            const r = raiz(i);
            grupos[r] = grupos[r] || { items: [], score: 0 };
            grupos[r].items.push(ind[i].item);
            grupos[r].score = Math.max(grupos[r].score, mejorPar[i]);
        }
        return Object.keys(grupos).map(function (k) { return grupos[k]; })
            .sort(function (a, b) { return b.score - a.score; });
    }

    return { limpiar: limpiar, fonetico: fonetico, preparar: preparar, indexar: indexar, buscar: buscar, similitud: similitud, parecidos: parecidos, agruparDuplicados: agruparDuplicados };
});
