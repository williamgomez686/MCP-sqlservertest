const express = require('express');
const bodyParser = require('body-parser');
const sql = require('mssql');
const { db, apiToken } = require('./config');
const { execSync } = require('child_process');

const app = express();
app.use(bodyParser.json());

// Autenticación por token
app.use((req, res, next) => {
  if (req.headers['x-api-token'] !== apiToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Pool global
let pool;
async function getPool() {
  if (!pool) pool = await sql.connect(db);
  return pool;
}

/** 1. Listar tablas de la base de datos */
app.post('/sql/tables', async (req, res) => {
  try {
    const p = await getPool();
    const result = await p.request()
      .query(`SELECT TABLE_SCHEMA, TABLE_NAME
              FROM INFORMATION_SCHEMA.TABLES
              WHERE TABLE_TYPE='BASE TABLE'`);
    res.json({ tables: result.recordset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 2. Describir columnas de una tabla */
app.post('/sql/describe', async (req, res) => {
  const { schema, table } = req.body;
  try {
    const p = await getPool();
    const q  = `
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA=@schema AND TABLE_NAME=@table
    `;
    const result = await p.request()
      .input('schema', sql.NVarChar, schema)
      .input('table', sql.NVarChar, table)
      .query(q);
    res.json({ columns: result.recordset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 3. Ejecutar una consulta arbitraria (solo SELECT) */
app.post('/sql/query', async (req, res) => {
  const { sqlText } = req.body;
  if (!/^select/i.test(sqlText)) {
    return res.status(400).json({ error: 'Solo se permiten SELECT.' });
  }
  try {
    const p = await getPool();
    const result = await p.request().query(sqlText);
    res.json({ rows: result.recordset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inicia el servidor
const PORT = 3001;
/** 4. Preguntar a Ollama y ejecutar la consulta sugerida */
app.post('/sql/ask-ollama', async (req, res) => {
  const { question } = req.body;
  if (!question) {
    return res.status(400).json({ error: 'La propiedad "question" es requerida.' });
  }

  try {
    // 1. Obtener nombres de las tablas para el contexto del prompt
    const p = await getPool();
    const tablesResult = await p.request()
      .query(`SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE'`);
    const tableNames = tablesResult.recordset.map(t => t.TABLE_NAME).join(', ');

    // 2. Construir el prompt para Ollama
    const prompt = `
      Basado en el siguiente esquema de SQL Server con las tablas (${tableNames}), genera una única consulta SQL SELECT para responder a la pregunta del usuario. 
      La consulta no debe contener saltos de línea ni caracteres de escape. Solo el texto SQL.
      Pregunta: "${question}"
      SQL Query: 
    `;

    // 3. Llamar a Ollama para generar la consulta SQL
    console.log(`[Ollama] Enviando prompt...`);
    const ollamaOutput = execSync(`ollama run llama2 "${prompt.replace(/"/g, '\"')}"`);
    const sqlText = ollamaOutput.toString().trim();
    console.log(`[Ollama] SQL generado: ${sqlText}`);

    // 4. Validar y ejecutar la consulta generada
    if (!/^select/i.test(sqlText)) {
      return res.status(400).json({ error: 'Ollama no generó una consulta SELECT válida.', suggestion: sqlText });
    }

    const queryResult = await p.request().query(sqlText);
    res.json({ 
      question,
      sql: sqlText,
      rows: queryResult.recordset 
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`MCP-SQL escuchando en http://localhost:${PORT}`);
});