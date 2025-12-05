const mysql = require('mysql2');
const dotenv = require('dotenv');
dotenv.config();

// Creamos un "pool" (grupo de conexiones) para que sea rápido
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Probamos la conexión al iniciar para ver si hay errores
pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Error conectando a MySQL Workbench:', err.code);
        console.error('   Revisa tu contraseña en el archivo .env');
    } else {
        console.log('✅ Conectado exitosamente a la base de datos MySQL local');
        connection.release();
    }
});

// Exportamos la versión con Promesas para usar async/await (código moderno)
module.exports = pool.promise();