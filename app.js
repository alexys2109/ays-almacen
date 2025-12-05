const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const compression = require('compression');
const db = require('./src/config/db');

dotenv.config();
const app = express();

app.use(compression());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// ==========================================
//                 RUTAS
// ==========================================

// --- 1. INICIO (BUSCAR) ---
app.get('/', async (req, res) => {
    const token = req.cookies.jwt;
    if (!token) return res.redirect('/login');
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const [productos] = await db.query('SELECT * FROM productos ORDER BY nombre ASC');
        const [categorias] = await db.query('SELECT * FROM categorias ORDER BY nombre ASC');
        res.render('index', { titulo: 'Buscar Productos', usuario: decoded.user, productos, categorias });
    } catch (error) { res.clearCookie('jwt'); res.redirect('/login'); }
});

// --- 2. DUPLICADOS (CORREGIDO PARA TiDB CLOUD) ---
app.get('/duplicados', async (req, res) => {
    const token = req.cookies.jwt;
    if (!token) return res.redirect('/login');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    try {
        // 1. Traemos TODOS los productos no verificados (Sin usar SOUNDEX en SQL)
        const [productos] = await db.query('SELECT * FROM productos WHERE verificado = 0 ORDER BY nombre ASC');

        // 2. Agrupamos por sonido usando JAVASCRIPT (No la base de datos)
        const gruposTemp = {};
        
        productos.forEach(prod => {
            // Calculamos el código fonético aquí
            const codigo = soundexJS(prod.nombre);
            
            if (!gruposTemp[codigo]) {
                gruposTemp[codigo] = [];
            }
            gruposTemp[codigo].push(prod);
        });

        // 3. Filtramos solo los que tienen más de 1 coincidencia
        const gruposFinales = {};
        for (const [codigo, items] of Object.entries(gruposTemp)) {
            if (items.length > 1) {
                gruposFinales[codigo] = items;
            }
        }

        res.render('duplicados', { usuario: decoded.user, grupos: gruposFinales });

    } catch (error) {
        console.error("Error en duplicados:", error);
        res.render('duplicados', { usuario: decoded.user, grupos: {} });
    }
});

// API: VALIDAR PRODUCTO
app.post('/api/verificar/:id', async (req, res) => {
    await db.query('UPDATE productos SET verificado = 1 WHERE id = ?', [req.params.id]);
    res.redirect('/duplicados');
});

// --- 3. AGREGAR ---
app.get('/agregar', async (req, res) => {
    const token = req.cookies.jwt;
    if (!token) return res.redirect('/login');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const [categorias] = await db.query('SELECT * FROM categorias ORDER BY nombre ASC');
    res.render('agregar', { usuario: decoded.user, categorias, exito: req.query.exito });
});
app.post('/agregar', async (req, res) => {
    let { nombre, precio_compra, precio_mayor, precio_unidad, categoria_id } = req.body;
    if (categoria_id === "") categoria_id = null;
    await db.query('INSERT INTO productos (nombre, precio_compra, precio_mayor, precio_unidad, categoria_id) VALUES (?,?,?,?,?)', 
    [nombre, precio_compra, precio_mayor, precio_unidad, categoria_id]);
    res.redirect('/agregar?exito=true');
});

// --- 4. MODIFICAR ---
app.get('/modificar', async (req, res) => {
    const token = req.cookies.jwt;
    if (!token) return res.redirect('/login');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const [productos] = await db.query('SELECT * FROM productos ORDER BY nombre ASC');
    const [categorias] = await db.query('SELECT * FROM categorias ORDER BY nombre ASC');
    res.render('modificar', { usuario: decoded.user, productos, categorias });
});
app.post('/modificar/guardar/:id', async (req, res) => {
    const { nombre, precio_compra, precio_mayor, precio_unidad, categoria_id } = req.body;
    await db.query('UPDATE productos SET nombre=?, precio_compra=?, precio_mayor=?, precio_unidad=?, categoria_id=? WHERE id=?',
    [nombre, precio_compra, precio_mayor, precio_unidad, categoria_id, req.params.id]);
    res.redirect('/modificar');
});

// --- 5. ELIMINAR ---
app.get('/eliminar-menu', async (req, res) => {
    const token = req.cookies.jwt;
    if (!token) return res.redirect('/login');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const [productos] = await db.query('SELECT * FROM productos ORDER BY nombre ASC');
    const [categorias] = await db.query('SELECT * FROM categorias ORDER BY nombre ASC');
    res.render('eliminar', { usuario: decoded.user, productos, categorias });
});
app.get('/eliminar/:id', async (req, res) => {
    const origen = req.query.origen;
    await db.query('DELETE FROM productos WHERE id = ?', [req.params.id]);
    if (origen === 'duplicados') res.redirect('/duplicados');
    else res.redirect('/eliminar-menu');
});

// --- 6. LISTA ---
app.get('/lista', async (req, res) => {
    const token = req.cookies.jwt;
    if (!token) return res.redirect('/login');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const [listasHoy] = await db.query('SELECT * FROM listas WHERE fecha = CURDATE() ORDER BY id DESC');
    const [listasHistorial] = await db.query('SELECT * FROM listas WHERE fecha < CURDATE() ORDER BY fecha DESC LIMIT 10');
    const [items] = await db.query('SELECT * FROM items_lista');

    const armarListas = (listas) => {
        return listas.map(lista => {
            lista.items = items.filter(i => i.lista_id === lista.id);
            return lista;
        });
    };

    res.render('lista', { 
        usuario: decoded.user, 
        listasHoy: armarListas(listasHoy),
        listasHistorial: armarListas(listasHistorial)
    });
});

app.post('/api/listas/crear', async (req, res) => {
    const { nombre_lista } = req.body;
    if(nombre_lista) await db.query('INSERT INTO listas (nombre_lista, fecha) VALUES (?, CURDATE())', [nombre_lista]);
    res.redirect('/lista');
});
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
app.get('/api/listas/eliminar/:id', async (req, res) => {
    await db.query('DELETE FROM listas WHERE id = ?', [req.params.id]);
    res.redirect('/lista');
});

// --- LOGIN ---
app.get('/login', (req, res) => { if(req.cookies.jwt) return res.redirect('/'); res.render('login'); });
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const [rows] = await db.query('SELECT * FROM usuarios WHERE username = ?', [username]);
    if (rows.length === 0 || password !== rows[0].password) return res.render('login', { error: 'Datos incorrectos' });
    const token = jwt.sign({ id: rows[0].id, user: rows[0].username }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.cookie('jwt', token, { httpOnly: true, maxAge: 30 * 24 * 3600000 });
    res.redirect('/');
});
app.get('/logout', (req, res) => { res.clearCookie('jwt'); res.redirect('/login'); });

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
