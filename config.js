// Lee la clave de API desde las variables de entorno para producción,
// o usa la clave local para desarrollo.
const openRouterApiKey = process.env.OPENROUTER_API_KEY || '';

// En un entorno de producción, es obligatorio que la clave de API esté definida como una variable de entorno.
if (process.env.NODE_ENV === 'production' && !process.env.OPENROUTER_API_KEY) {
  console.error('Error: La variable de entorno OPENROUTER_API_KEY no está definida en producción.');
  process.exit(1); // Detiene la aplicación si la clave no está configurada en producción
}

module.exports = {
  openRouterApiKey,
  db: {
    user: 'clinicadb',
    password: 'Abc1234$',
    server: 'clinica_mastersync.mssql.somee.com',
    database: 'clinica_mastersync',
    options: {
      encrypt: true,
      trustServerCertificate: true
    }
  },
  apiToken: 'mcp123'
};