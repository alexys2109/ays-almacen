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

module.exports = pool.promise();
