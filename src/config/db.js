const mysql = require('mysql2');
const dotenv = require('dotenv');
dotenv.config();

// Creamos un "pool" con SSL activado para TiDB
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 4000, // TiDB usa puerto 4000
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    // La base de datos en la nube corta las conexiones que llevan un rato sin usarse. Para que la primera consulta
    // después de un rato no se quede esperando (o falle), se cierran las inactivas antes y se mantienen vivas las demás.
    maxIdle: 3,
    idleTimeout: 60000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    // --- ESTO ES LO NUEVO QUE SOLUCIONA EL ERROR ---
    ssl: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true
    }
});

// Probamos la conexión al iniciar
pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Error conectando a la Base de Datos:', err.code);
        console.error('Mensaje:', err.message);
    } else {
        console.log('✅ Conectado exitosamente a la base de datos en la nube ☁️');
        connection.release();
    }
});

// Si una consulta falla porque la conexión estaba cortada, se reintenta una vez con una conexión nueva
const poolPromesa = pool.promise();
const TRANSITORIOS = new Set(['ECONNRESET', 'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'ER_CON_COUNT_ERROR']);
async function query(...args) {
    try {
        return await poolPromesa.query(...args);
    } catch (e) {
        if (TRANSITORIOS.has(e.code) || /connection lost|closed state|read ECONNRESET/i.test(e.message || '')) {
            console.warn('♻️ Conexión a la base cortada (' + (e.code || e.message) + '), reintentando...');
            return await poolPromesa.query(...args);
        }
        throw e;
    }
}

module.exports = { query, pool: poolPromesa };
