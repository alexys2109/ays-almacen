const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const compression = require('compression');
const db = require('./src/config/db'); // Conexión a Base de Datos

dotenv.config();
const app = express();

// --- OPTIMIZACIONES (VELOCIDAD Y CACHÉ) ---
app.use(compression());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' })); // Caché de 1 día para CSS/Imágenes
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// ==========================================
//                 RUTAS
// ==========================================

// --- 1. INICIO (BUSCAR CON FILTROS) ---
app.get('/', async (req, res) => {
    const token = req.cookies.jwt;
    if (!token) return res.redirect('/login');
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        // Traemos productos Y categorías para los filtros del buscador
        const [productos] = await db.query('SELECT * FROM productos ORDER BY nombre ASC');
        const [categorias] = await db.query('SELECT * FROM categorias ORDER BY nombre ASC');
        
        res.render('index', { titulo: 'Buscar Productos', usuario: decoded.user, productos, categorias });
    } catch (error) { res.clearCookie('jwt'); res.redirect('/login'); }
});

// --- 2. DUPLICADOS (LÓGICA JAVASCRIPT PARA TiDB) ---
app.get('/duplicados', async (req, res) => {
    const token = req.cookies.jwt;
    if (!token) return res.redirect('/login');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    try {
        // 1. Traer productos NO verificados
        const [productos] = await db.query('SELECT * FROM productos WHERE verificado = 0 ORDER BY nombre ASC');

        // 2. Agrupar por sonido (Soundex) usando JAVASCRIPT
        const gruposTemp = {};
        productos.forEach(prod => {
            const codigo = soundexJS(prod.nombre);
            if (!gruposTemp[codigo]) gruposTemp[codigo] = [];
            gruposTemp[codigo].push(prod);
        });

        // 3. Filtrar solo los grupos que tienen más de 1 producto (repetidos)
        const gruposFinales = {};
        for (const [codigo, items] of Object.entries(gruposTemp)) {
            if (items.length > 1) gruposFinales[codigo] = items;
        }

        res.render('duplicados', { usuario: decoded.user, grupos: gruposFinales });
    } catch (error) {
        console.error(error);
        res.render('duplicados', { usuario: decoded.user, grupos: {} });
    }
});

// API: Validar Producto (Quitar de duplicados)
app.post('/api/verificar/:id', async (req, res) => {
    await db.query('UPDATE productos SET verificado = 1 WHERE id = ?', [req.params.id]);
    res.redirect('/duplicados');
});

// --- 3. AGREGAR PRODUCTO ---
app.get('/agregar', async (req, res) => {
    const token = req.cookies.jwt;
    if (!token) return res.redirect('/login');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Necesitamos categorías para el select
    const [categorias] = await db.query('SELECT * FROM categorias ORDER BY nombre ASC');
    res.render('agregar', { usuario: decoded.user, categorias, exito: req.query.exito });
});

app.post('/agregar', async (req, res) => {
    let { nombre, precio_compra, precio_mayor, precio_unidad, categoria_id } = req.body;
    
    // Si la categoría viene vacía, enviamos NULL a la BD
    if (categoria_id === "") categoria_id = null;

    await db.query(
        'INSERT INTO productos (nombre, precio_compra, precio_mayor, precio_unidad, categoria_id) VALUES (?,?,?,?,?)', 
        [nombre, precio_compra, precio_mayor, precio_unidad, categoria_id]
    );
    res.redirect('/agregar?exito=true');
});

// --- 4. MODIFICAR (CON FILTROS) ---
app.get('/modificar', async (req, res) => {
    const token = req.cookies.jwt;
    if (!token) return res.redirect('/login');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Traemos productos y categorías para poder filtrar en la vista
    const [productos] = await db.query('SELECT * FROM productos ORDER BY nombre ASC');
    const [categorias] = await db.query('SELECT * FROM categorias ORDER BY nombre ASC');

    res.render('modificar', { usuario: decoded.user, productos, categorias });
});

app.post('/modificar/guardar/:id', async (req, res) => {
    const { nombre, precio_compra, precio_mayor, precio_unidad, categoria_id } = req.body;
    await db.query(
        'UPDATE productos SET nombre=?, precio_compra=?, precio_mayor=?, precio_unidad=?, categoria_id=? WHERE id=?',
        [nombre, precio_compra, precio_mayor, precio_unidad, categoria_id, req.params.id]
    );
    res.redirect('/modificar');
});

// --- 5. ELIMINAR (CON FILTROS) ---
app.get('/eliminar-menu', async (req, res) => {
    const token = req.cookies.jwt;
    if (!token) return res.redirect('/login');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const [productos] = await db.query('SELECT * FROM productos ORDER BY nombre ASC');
    const [categorias] = await db.query('SELECT * FROM categorias ORDER BY nombre ASC');
    
    res.render('eliminar', { usuario: decoded.user, productos, categorias });
});

app.get('/eliminar/:id', async (req, res) => {
    const origen = req.query.origen; // Saber si venimos de "duplicados"
    
    await db.query('DELETE FROM productos WHERE id = ?', [req.params.id]);
    
    if (origen === 'duplicados') res.redirect('/duplicados');
    else res.redirect('/eliminar-menu');
});

// --- 6. LISTA ALMACÉN (LÓGICA NUEVA: ESTADOS) ---
app.get('/lista', async (req, res) => {
    const token = req.cookies.jwt;
    if (!token) return res.redirect('/login');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // 1. Listas ACTIVAS (estado = 1). Se quedan aquí siempre.
    const [listasActivas] = await db.query('SELECT * FROM listas WHERE estado = 1 ORDER BY id DESC');
    
    // 2. Listas ARCHIVADAS (estado = 0). Historial.
    const [listasHistorial] = await db.query('SELECT * FROM listas WHERE estado = 0 ORDER BY id DESC LIMIT 10');

    // 3. Ítems de todas las listas
    const [items] = await db.query('SELECT * FROM items_lista');

    // Función para meter los ítems dentro de su lista correspondiente
    const armarListas = (listas) => {
        return listas.map(lista => {
            lista.items = items.filter(i => i.lista_id === lista.id);
            return lista;
        });
    };

    res.render('lista', { 
        usuario: decoded.user, 
        listasHoy: armarListas(listasActivas),
        listasHistorial: armarListas(listasHistorial)
    });
});

// API: Listas
app.post('/api/listas/crear', async (req, res) => {
    const { nombre_lista } = req.body;
    // Crea lista con estado=1 (Activa) y fecha de hoy
    if(nombre_lista) await db.query('INSERT INTO listas (nombre_lista, fecha, estado) VALUES (?, CURDATE(), 1)', [nombre_lista]);
    res.redirect('/lista');
});

app.get('/api/listas/archivar/:id', async (req, res) => {
    await db.query('UPDATE listas SET estado = 0 WHERE id = ?', [req.params.id]);
    res.redirect('/lista');
});

app.get('/api/listas/restaurar/:id', async (req, res) => {
    await db.query('UPDATE listas SET estado = 1 WHERE id = ?', [req.params.id]);
    res.redirect('/lista');
});

app.get('/api/listas/eliminar/:id', async (req, res) => {
    await db.query('DELETE FROM listas WHERE id = ?', [req.params.id]);
    res.redirect('/lista');
});

// API: Ítems
app.post('/api/items/agregar', async (req, res) => {
    const { lista_id, texto } = req.body;
    if(lista_id && texto) await db.query('INSERT INTO items_lista (lista_id, texto) VALUES (?, ?)', [lista_id, texto]);
    res.redirect('/lista');
});

app.post('/api/items/toggle/:id', async (req, res) => {
    await db.query('UPDATE items_lista SET completado = NOT completado WHERE id = ?', [req.params.id]);
    res.sendStatus(200);
});

app.get('/api/items/eliminar/:id', async (req, res) => {
    await db.query('DELETE FROM items_lista WHERE id = ?', [req.params.id]);
    res.redirect('/lista');
});


// ==========================================
//           LOGIN Y SEGURIDAD
// ==========================================

app.get('/login', (req, res) => { if(req.cookies.jwt) return res.redirect('/'); res.render('login'); });

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await db.query('SELECT * FROM usuarios WHERE username = ?', [username]);
        if (rows.length === 0 || password !== rows[0].password) return res.render('login', { error: 'Datos incorrectos' });

        const token = jwt.sign({ id: rows[0].id, user: rows[0].username }, process.env.JWT_SECRET, { expiresIn: '30d' });

        // --- COOKIE BLINDADA PARA SAMSUNG/ANDROID ---
        res.cookie('jwt', token, { 
            httpOnly: true, 
            maxAge: 30 * 24 * 60 * 60 * 1000, // 30 días
            secure: true,    // Obligatorio para HTTPS
            sameSite: 'lax'  // Compatibilidad móvil mejorada
        });
        
        res.redirect('/');
    } catch (error) {
        console.error(error);
        res.render('login', { error: 'Error de servidor' });
    }
});

app.get('/logout', (req, res) => { 
    res.clearCookie('jwt'); 
    res.redirect('/login'); 
});

// Iniciar Servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🚀 Servidor listo en http://localhost:${PORT}`); });


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
