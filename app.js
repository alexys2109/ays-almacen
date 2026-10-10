const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const compression = require('compression');
const crypto = require('crypto');
const db = require('./src/config/db'); // Tu conexión a TiDB
const Similitud = require('./public/js/similitud');
const Frescura = require('./public/js/frescura');

dotenv.config();
const app = express();
app.set('trust proxy', 1); // Render va detrás de un proxy HTTPS (para req.secure)
app.locals.ver = Date.now(); // versión para que el navegador no use JS viejo en caché

// --- CONFIGURACIÓN Y MIDDLEWARE ---
app.use(compression()); // Comprimir respuestas (Velocidad)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' })); // Cachear CSS
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// Chequeo liviano (no usa la base de datos): sirve para mantener despierto el servicio con un monitor externo
app.get('/salud', (req, res) => res.type('text').send('ok'));

// ==========================================
//   SESIÓN PERMANENTE (ESTILO FACEBOOK)
// ==========================================
// La sesión dura hasta que el usuario cierre sesión: la cookie se renueva sola
// mientras use la app, así que solo vence si pasa ~1 año sin entrar.
const SESION_MS = 365 * 24 * 60 * 60 * 1000;
const RENOVAR_DESPUES_S = 24 * 60 * 60; // renovar como máximo 1 vez al día

function opcionesCookie(req) {
    return { httpOnly: true, maxAge: SESION_MS, secure: req.secure, sameSite: 'lax' };
}

function crearSesion(req, res, usuario) {
    const token = jwt.sign({ id: usuario.id, user: usuario.username }, process.env.JWT_SECRET, { expiresIn: '365d' });
    res.cookie('jwt', token, opcionesCookie(req));
}

// Firma ligada a la contraseña actual: si la cambian, las cuentas guardadas dejan de valer.
function huellaClave(password) {
    return crypto.createHmac('sha256', process.env.JWT_SECRET).update(String(password)).digest('hex').slice(0, 16);
}

// Token de "cuenta guardada" (la cajita del login). No vence; se invalida si cambia la contraseña.
function crearTokenGuardado(usuario) {
    return jwt.sign({ id: usuario.id, user: usuario.username, tipo: 'guardada', h: huellaClave(usuario.password) }, process.env.JWT_SECRET);
}

app.use((req, res, next) => {
    const token = req.cookies.jwt;
    if (!token) return next();
    try {
        const d = jwt.verify(token, process.env.JWT_SECRET);
        if (d.iat && Date.now() / 1000 - d.iat > RENOVAR_DESPUES_S) {
            crearSesion(req, res, { id: d.id, username: d.user });
        }
    } catch (e) { /* token inválido: cada ruta decide qué hacer */ }
    next();
});

// ==========================================
//   FRESCURA DE PRECIOS (esquema + helpers)
// ==========================================
// precio_cambiado   = última vez que un precio REALMENTE cambió (o se creó el producto)
// precio_confirmado = última vez que alguien revisó y confirmó que el precio sigue vigente
async function asegurarEsquema() {
    const [cols] = await db.query(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productos' AND COLUMN_NAME IN ('precio_cambiado','precio_confirmado')");
    const existentes = cols.map(c => c.COLUMN_NAME);
    if (!existentes.includes('precio_cambiado')) {
        await db.query('ALTER TABLE productos ADD COLUMN precio_cambiado TIMESTAMP NULL DEFAULT NULL');
        // fecha = fecha evita que el ON UPDATE de "fecha" la cambie a "hoy"
        await db.query('UPDATE productos SET precio_cambiado = fecha, fecha = fecha WHERE precio_cambiado IS NULL');
        console.log('🛠️  Columna precio_cambiado creada');
    }
    if (!existentes.includes('precio_confirmado')) {
        await db.query('ALTER TABLE productos ADD COLUMN precio_confirmado TIMESTAMP NULL DEFAULT NULL');
        console.log('🛠️  Columna precio_confirmado creada');
    }
}

// Segundos transcurridos calculados por la base de datos (sin problemas de zona horaria)
const COLS_PRODUCTO = `p.*,
    TIMESTAMPDIFF(SECOND, p.precio_cambiado, NOW()) AS seg_cambio,
    TIMESTAMPDIFF(SECOND, p.precio_confirmado, NOW()) AS seg_confirmado`;

// Caché en memoria de la lista de productos (se invalida en cada cambio). Evita ir a la base de datos
// en la nube en cada pantalla. Los "segundos transcurridos" se ajustan según el tiempo que lleva en caché.
let cacheProductos = { filas: null, en: 0 };
const VIDA_CACHE_MS = 30 * 1000;
function invalidarProductos() { cacheProductos = { filas: null, en: 0 }; }
async function listarProductos() {
    if (!cacheProductos.filas || Date.now() - cacheProductos.en > VIDA_CACHE_MS) {
        const [filas] = await db.query(`SELECT ${COLS_PRODUCTO} FROM productos p ORDER BY p.nombre ASC`);
        cacheProductos = { filas, en: Date.now() };
    }
    const extra = Math.floor((Date.now() - cacheProductos.en) / 1000);
    if (!extra) return cacheProductos.filas;
    return cacheProductos.filas.map(p => ({
        ...p,
        seg_cambio: p.seg_cambio === null ? null : Number(p.seg_cambio) + extra,
        seg_confirmado: p.seg_confirmado === null ? null : Number(p.seg_confirmado) + extra
    }));
}

const limpiarNombre = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// Tokens de un solo uso para que el mismo formulario de "Agregar" no se guarde dos veces (doble toque, reenvío)
const tokensAgregar = new Set();
function nuevoTokenAgregar() {
    const t = crypto.randomUUID();
    tokensAgregar.add(t);
    if (tokensAgregar.size > 5000) tokensAgregar.delete(tokensAgregar.values().next().value);
    return t;
}

function auth(req, res, next) {
    try {
        req.usuario = jwt.verify(req.cookies.jwt || '', process.env.JWT_SECRET).user;
        next();
    } catch (e) {
        if (req.path.startsWith('/api') || req.method !== 'GET') return res.status(401).json({ error: 'sesion' });
        res.redirect('/login');
    }
}

function precioONull(v) {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// Lee un precio escrito por el usuario. Acepta coma decimal. { valor, valido }
function leerPrecio(v) {
    if (v === undefined || v === null || String(v).trim() === '') return { valor: null, valido: true };
    const n = Number(String(v).trim().replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || n > 99999999) return { valor: null, valido: false };
    return { valor: Math.round(n * 100) / 100, valido: true };
}
const MAX_NOMBRE = 100;
function precioCambio(a, b) {
    if (a === null || b === null) return a !== b;
    return Math.abs(Number(a) - Number(b)) > 0.0049;
}

// ==========================================
//                 RUTAS
// ==========================================

// --- 1. INICIO (BUSCAR) ---
app.get('/', async (req, res) => {
    const token = req.cookies.jwt;
    if (!token) return res.redirect('/login');
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        // Traemos todo para los filtros del buscador
        const [productos, [categorias]] = await Promise.all([
            listarProductos(),
            db.query('SELECT * FROM categorias ORDER BY nombre ASC')
        ]);
        
        res.render('index', { titulo: 'Buscar Productos', usuario: decoded.user, productos, categorias });
    } catch (error) { res.clearCookie('jwt'); res.redirect('/login'); }
});

// --- 2. DUPLICADOS (similitud por palabras + sonido, calculada en JS porque TiDB no tiene SOUNDEX) ---
let cacheDuplicados = { clave: null, grupos: [] };
function calcularGrupos(productos) {
    const clave = crypto.createHash('md5').update(productos.map(p => p.id + '|' + p.nombre + '|' + (p.verificado ? 1 : 0)).join('\n')).digest('hex');
    if (cacheDuplicados.clave !== clave) {
        // Solo se muestran los grupos donde queda al menos un producto sin revisar
        const grupos = Similitud.agruparDuplicados(productos, 0.8).filter(g => g.items.some(p => !p.verificado));
        cacheDuplicados = { clave, grupos };
    }
    return cacheDuplicados.grupos;
}

app.get('/duplicados', auth, async (req, res) => {
    try {
        const productos = await listarProductos();
        const grupos = calcularGrupos(productos).map(g => ({
            score: g.score,
            items: g.items.map(p => ({ ...p, seg_precio: Frescura.segundosPrecio(p) }))
        }));
        res.render('duplicados', { usuario: req.usuario, grupos, Frescura });
    } catch (error) {
        console.error(error);
        res.render('duplicados', { usuario: req.usuario, grupos: [], Frescura });
    }
});

app.post('/api/verificar/:id', auth, async (req, res) => {
    await db.query('UPDATE productos SET verificado = 1 WHERE id = ?', [req.params.id]);
    invalidarProductos();
    res.redirect('/duplicados');
});

// Marcar varios productos como "correctos / son distintos"
app.post('/api/verificar-grupo', auth, async (req, res) => {
    const ids = String(req.body.ids || '').split(',').map(Number).filter(Number.isInteger);
    if (ids.length) await db.query('UPDATE productos SET verificado = 1 WHERE id IN (?)', [ids]);
    invalidarProductos();
    res.redirect('/duplicados');
});

// Conservar uno y eliminar los demás del grupo
app.post('/api/duplicados/conservar', auth, async (req, res) => {
    const conservar = Number(req.body.conservar);
    const eliminar = String(req.body.eliminar || '').split(',').map(Number).filter(n => Number.isInteger(n) && n !== conservar);
    if (Number.isInteger(conservar) && eliminar.length) {
        await db.query('DELETE FROM productos WHERE id IN (?)', [eliminar]);
        await db.query('UPDATE productos SET verificado = 1 WHERE id = ?', [conservar]);
        invalidarProductos();
    }
    res.redirect('/duplicados');
});

// --- 3. AGREGAR ---
app.get('/agregar', auth, async (req, res) => {
    // Lista de productos para avisar de parecidos mientras se escribe
    const [categorias, productos] = await Promise.all([
        db.query('SELECT * FROM categorias ORDER BY nombre ASC').then(r => r[0]),
        listarProductos()
    ]);
    res.render('agregar', { usuario: req.usuario, categorias, exito: req.query.exito, error: req.query.error || '', productos, token: nuevoTokenAgregar() });
});

app.post('/agregar', auth, async (req, res) => {
    let { categoria_id, token } = req.body;
    const nombre = limpiarNombre(req.body.nombre);
    if (!categoria_id) categoria_id = null;
    if (!nombre) return res.redirect('/agregar');
    // Datos inválidos: se vuelve al formulario con un aviso (sin gastar el token del formulario)
    const compra = leerPrecio(req.body.precio_compra), mayor = leerPrecio(req.body.precio_mayor), unidad = leerPrecio(req.body.precio_unidad);
    if (nombre.length > MAX_NOMBRE) return res.redirect('/agregar?error=nombre');
    if (!compra.valido || !mayor.valido || !unidad.valido) return res.redirect('/agregar?error=precio');

    // Anti-duplicado por doble envío: el formulario solo vale una vez...
    if (!token || !tokensAgregar.delete(token)) return res.redirect('/agregar?exito=true');
    // ...y además no se crea otro producto igual en los últimos 2 minutos
    const [recientes] = await db.query(
        "SELECT id FROM productos WHERE LOWER(TRIM(nombre)) = LOWER(?) AND precio_cambiado > NOW() - INTERVAL 120 SECOND LIMIT 1", [nombre]);
    if (recientes.length) return res.redirect('/agregar?exito=true');

    await db.query('INSERT INTO productos (nombre, precio_compra, precio_mayor, precio_unidad, categoria_id, precio_cambiado) VALUES (?,?,?,?,?, NOW())',
    [nombre, compra.valor, mayor.valor, unidad.valor, categoria_id]);
    invalidarProductos();
    res.redirect('/agregar?exito=true');
});

// --- 4. MODIFICAR ---
// La página carga todos los productos una sola vez (/api/productos/todos) y filtra/ordena en el navegador
// con la búsqueda tolerante a errores. Admite ?id=123 para abrir un producto concreto.
app.get('/modificar', auth, async (req, res) => {
    const [categorias] = await db.query('SELECT * FROM categorias ORDER BY nombre ASC');
    res.render('modificar', { usuario: req.usuario, categorias, idSel: req.query.id || '' });
});

app.get('/api/productos/todos', auth, async (req, res) => {
    res.json(await listarProductos());
});

// (se mantiene por compatibilidad)
app.get('/api/productos', auth, async (req, res) => {
    const { busqueda, categoria, page } = req.query;
    const limit = 20;
    const offset = ((Number(page) || 1) - 1) * limit;

    let query = `SELECT ${COLS_PRODUCTO} FROM productos p`;
    let params = [];
    let condiciones = [];

    if (busqueda) {
        condiciones.push('p.nombre LIKE ?');
        params.push(`%${busqueda}%`);
    }
    if (categoria) {
        condiciones.push('p.categoria_id = ?');
        params.push(categoria);
    }

    if (condiciones.length > 0) query += ' WHERE ' + condiciones.join(' AND ');

    query += ' ORDER BY p.nombre ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const [productos] = await db.query(query, params);
    res.json(productos);
});

app.post('/modificar/guardar/:id', auth, async (req, res) => {
    const quiereJson = (req.get('accept') || '').includes('application/json');
    try {
        const { categoria_id } = req.body;
        const nombre = limpiarNombre(req.body.nombre);
        if (!nombre) return quiereJson ? res.status(400).json({ error: 'Nombre vacío' }) : res.redirect('/modificar');
        if (nombre.length > MAX_NOMBRE) return quiereJson ? res.status(400).json({ error: 'El nombre es muy largo (máximo ' + MAX_NOMBRE + ' letras).' }) : res.redirect('/modificar');
        const pc = leerPrecio(req.body.precio_compra), pm = leerPrecio(req.body.precio_mayor), pu = leerPrecio(req.body.precio_unidad);
        if (!pc.valido || !pm.valido || !pu.valido) return quiereJson ? res.status(400).json({ error: 'Revisa los precios: deben ser números (0 o más).' }) : res.redirect('/modificar');
        const compra = pc.valor, mayor = pm.valor, unidad = pu.valor;

        const [filas] = await db.query('SELECT precio_compra, precio_mayor, precio_unidad FROM productos WHERE id = ?', [req.params.id]);
        if (!filas.length) return quiereJson ? res.status(404).json({ error: 'No existe' }) : res.redirect('/modificar');
        const a = filas[0];
        const cambioPrecio = precioCambio(precioONull(a.precio_compra), compra) ||
                             precioCambio(precioONull(a.precio_mayor), mayor) ||
                             precioCambio(precioONull(a.precio_unidad), unidad);

        // Si algún precio cambió de verdad, se anota la fecha. Si solo se corrigió el nombre/categoría, no.
        await db.query(
            `UPDATE productos SET nombre=?, precio_compra=?, precio_mayor=?, precio_unidad=?, categoria_id=?
             ${cambioPrecio ? ', precio_cambiado = NOW()' : ''} WHERE id=?`,
            [nombre, compra, mayor, unidad, categoria_id || null, req.params.id]);
        invalidarProductos();

        if (!quiereJson) return res.redirect('/modificar');
        const [r] = await db.query(`SELECT ${COLS_PRODUCTO} FROM productos p WHERE p.id = ?`, [req.params.id]);
        res.json({ ok: true, cambioPrecio, producto: r[0] });
    } catch (error) {
        console.error(error);
        if (quiereJson) return res.status(500).json({ error: 'No se pudo guardar' });
        res.redirect('/modificar');
    }
});

// "El precio sigue igual": se revisó y está vigente (no cambia ningún precio)
app.post('/modificar/confirmar/:id', auth, async (req, res) => {
    try {
        await db.query('UPDATE productos SET precio_confirmado = NOW() WHERE id = ?', [req.params.id]);
        invalidarProductos();
        const [r] = await db.query(`SELECT ${COLS_PRODUCTO} FROM productos p WHERE p.id = ?`, [req.params.id]);
        res.json({ ok: true, producto: r[0] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'No se pudo confirmar' });
    }
});

// --- 5. ELIMINAR ---
app.get('/eliminar-menu', auth, async (req, res) => {
    const [productos, [categorias]] = await Promise.all([
        listarProductos(),
        db.query('SELECT * FROM categorias ORDER BY nombre ASC')
    ]);
    res.render('eliminar', { usuario: req.usuario, productos, categorias });
});

app.get('/eliminar/:id', auth, async (req, res) => {
    const origen = req.query.origen;
    await db.query('DELETE FROM productos WHERE id = ?', [req.params.id]);
    invalidarProductos();
    if (origen === 'duplicados') res.redirect('/duplicados');
    else res.redirect('/eliminar-menu');
});

// --- 6. LISTAS (ACTIVOS vs HISTORIAL) ---
app.get('/lista', auth, async (req, res) => {

    // Activas (Estado 1)
    const [listasActivas] = await db.query('SELECT * FROM listas WHERE estado = 1 ORDER BY id DESC');
    // Historial (Estado 0)
    const [listasHistorial] = await db.query('SELECT * FROM listas WHERE estado = 0 ORDER BY id DESC LIMIT 10');
    // Ítems
    const [items] = await db.query('SELECT * FROM items_lista');

    const armarListas = (listas) => listas.map(l => ({ ...l, items: items.filter(i => i.lista_id === l.id) }));

    res.render('lista', { usuario: req.usuario, listasHoy: armarListas(listasActivas), listasHistorial: armarListas(listasHistorial) });
});

// APIs de Listas
app.post('/api/listas/crear', auth, async (req, res) => {
    if(req.body.nombre_lista) await db.query('INSERT INTO listas (nombre_lista, fecha, estado) VALUES (?, CURDATE(), 1)', [req.body.nombre_lista]);
    res.redirect('/lista');
});
app.get('/api/listas/archivar/:id', auth, async (req, res) => {
    await db.query('UPDATE listas SET estado = 0 WHERE id = ?', [req.params.id]);
    res.redirect('/lista');
});
app.get('/api/listas/restaurar/:id', auth, async (req, res) => {
    await db.query('UPDATE listas SET estado = 1 WHERE id = ?', [req.params.id]);
    res.redirect('/lista');
});
app.get('/api/listas/eliminar/:id', auth, async (req, res) => {
    await db.query('DELETE FROM items_lista WHERE lista_id = ?', [req.params.id]); // no dejar ítems huérfanos
    await db.query('DELETE FROM listas WHERE id = ?', [req.params.id]);
    res.redirect('/lista');
});
// APIs de Ítems
app.post('/api/items/agregar', auth, async (req, res) => {
    if(req.body.texto) await db.query('INSERT INTO items_lista (lista_id, texto) VALUES (?, ?)', [req.body.lista_id, req.body.texto]);
    res.redirect('/lista');
});
app.post('/api/items/toggle/:id', auth, async (req, res) => {
    await db.query('UPDATE items_lista SET completado = NOT completado WHERE id = ?', [req.params.id]);
    res.sendStatus(200);
});
app.get('/api/items/eliminar/:id', auth, async (req, res) => {
    await db.query('DELETE FROM items_lista WHERE id = ?', [req.params.id]);
    res.redirect('/lista');
});


// ==========================================
//           LOGIN Y SEGURIDAD
// ==========================================

// Página puente: guarda/actualiza la cuenta en este dispositivo (localStorage) y continúa.
function paginaPuente(res, cuenta, destino) {
    res.render('puente', { cuenta: cuenta || null, destino });
}

app.get('/login', (req, res) => {
    const token = req.cookies.jwt;
    if (token) {
        try { jwt.verify(token, process.env.JWT_SECRET); return res.redirect('/'); }
        catch (e) { res.clearCookie('jwt'); }
    }
    res.render('login', { error: req.query.error || null });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await db.query('SELECT * FROM usuarios WHERE username = ?', [username]);
        if (rows.length === 0 || password !== rows[0].password) return res.render('login', { error: 'Datos incorrectos' });

        crearSesion(req, res, rows[0]);
        paginaPuente(res, { user: rows[0].username, token: crearTokenGuardado(rows[0]) }, '/');
    } catch (error) {
        console.error(error);
        res.render('login', { error: 'Error de servidor' });
    }
});

// Entrar tocando una cuenta guardada
app.post('/login/guardada', async (req, res) => {
    try {
        const d = jwt.verify(req.body.token || '', process.env.JWT_SECRET);
        if (d.tipo !== 'guardada') throw new Error('tipo');
        const [rows] = await db.query('SELECT * FROM usuarios WHERE id = ?', [d.id]);
        if (rows.length === 0 || huellaClave(rows[0].password) !== d.h) {
            return res.render('login', { error: 'La contraseña de "' + d.user + '" cambió o la cuenta ya no existe. Ingresa de nuevo con tu contraseña.' });
        }
        crearSesion(req, res, rows[0]);
        paginaPuente(res, { user: rows[0].username, token: crearTokenGuardado(rows[0]) }, '/');
    } catch (error) {
        // Error de base de datos / red: NO se borra nada, solo se avisa
        console.error(error);
        res.render('login', { error: 'No se pudo entrar ahora. Intenta de nuevo en unos segundos.' });
    }
});

app.get('/logout', async (req, res) => {
    // Antes de cerrar, aseguramos que la cuenta quede guardada en este dispositivo
    let cuenta = null;
    try {
        const d = jwt.verify(req.cookies.jwt || '', process.env.JWT_SECRET);
        const [rows] = await db.query('SELECT * FROM usuarios WHERE id = ?', [d.id]);
        if (rows.length) cuenta = { user: rows[0].username, token: crearTokenGuardado(rows[0]) };
    } catch (e) { /* sin sesión válida o BD caída: se cierra igual */ }
    res.clearCookie('jwt', { httpOnly: true, secure: req.secure, sameSite: 'lax' });
    paginaPuente(res, cuenta, '/login');
});

// Iniciar Servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🚀 Servidor listo en http://localhost:${PORT}`); });
asegurarEsquema().catch(e => console.error('❌ No se pudo preparar la tabla productos:', e.message));


// ==========================================
//   FUNCIÓN AUXILIAR: SOUNDEX EN JAVASCRIPT
// ==========================================
function soundexJS(s) {
    if(!s) return "";
    var a = s.toLowerCase().split('');
    var f = a.shift(),
        r = '',
        codes = {
            a: '', e: '', i: '', o: '', u: '',
            b: 1, f: 1, p: 1, v: 1,
            c: 2, g: 2, j: 2, k: 2, q: 2, s: 2, x: 2, z: 2,
            d: 3, t: 3,
            l: 4,
            m: 5, n: 5,
            r: 6
        };
    r = f +
        a
        .map(function (v, i, a) { return codes[v] })
        .filter(function (v, i, a) {
            return ((i === 0) ? v !== codes[f] : v !== a[i - 1]);
        })
        .join('');
    return (r + '000').slice(0, 4).toUpperCase();
}
