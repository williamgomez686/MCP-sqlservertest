// server.js
const express     = require('express');
const bodyParser  = require('body-parser');
const fs          = require('fs').promises;
const path        = require('path');
const sql         = require('mssql');
const { execSync }= require('child_process');
const { db, apiToken } = require('./config');

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));  // Sirve UI web desde public/

// --- Middleware de autenticación por token ---
app.use((req, res, next) => {
  if (req.headers['x-api-token'] !== apiToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// --- Helper: conexión a SQL Server con pool global ---
let pool;
async function getPool() {
  if (!pool) pool = await sql.connect(db);
  return pool;
}

/** 1. Navegar carpetas (para UI) */
app.post('/browse', async (req, res) => {
  try {
    const folder = req.body.folder;
    const items  = await fs.readdir(folder, { withFileTypes: true });
    const files  = items.filter(i => i.isFile()).map(i => i.name);
    const dirs   = items.filter(i => i.isDirectory()).map(i => i.name);
    res.json({ folders: dirs, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 2. Listar archivos de una carpeta */
app.post('/list', async (req, res) => {
  try {
    const items = await fs.readdir(req.body.folder);
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 3. Leer archivo de texto */
app.post('/read', async (req, res) => {
  try {
    const content = await fs.readFile(req.body.path, 'utf8');
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 4. Mover/renombrar un archivo */
app.post('/move', async (req, res) => {
  try {
    await fs.rename(req.body.src, req.body.dest);
    res.json({ moved: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 5. Copiar un archivo */
app.post('/copy', async (req, res) => {
  try {
    await fs.copyFile(req.body.src, req.body.dest);
    res.json({ copied: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 6. Eliminar un archivo */
app.post('/delete', async (req, res) => {
  try {
    await fs.unlink(req.body.path);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 7. Obtener metadatos de un archivo/carpeta */
app.post('/stat', async (req, res) => {
  try {
    const info = await fs.stat(req.body.path);
    res.json({
      size:      info.size,
      created:   info.birthtime,
      modified:  info.mtime,
      isFile:    info.isFile(),
      isDir:     info.isDirectory()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 8. Buscar texto (“grep”) en archivos .txt */
app.post('/grep', async (req, res) => {
  try {
    const { folder, pattern } = req.body;
    const regex = new RegExp(pattern, 'i');
    const files = await fs.readdir(folder);
    const matches = [];
    for (const f of files) {
      if (f.match(/\.txt$/i)) {
        const txt = await fs.readFile(path.join(folder, f), 'utf8');
        if (regex.test(txt)) matches.push(f);
      }
    }
    res.json({ matches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 9. Crear o sobrescribir un archivo */
app.post('/write', async (req, res) => {
  try {
    await fs.writeFile(req.body.path, req.body.content || '');
    res.json({ written: true, path: req.body.path });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** --- ENDPOINTS PARA SQL SERVER --- **/

/** 10. Listar tablas de la BD */
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

/** 11. Describir columnas de una tabla */
app.post('/sql/describe', async (req, res) => {
  const { schema, table } = req.body;
  try {
    const p = await getPool();
    const q = `
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA=@schema AND TABLE_NAME=@table
    `;
    const result = await p.request()
      .input('schema', sql.NVarChar, schema)
      .input('table',  sql.NVarChar, table)
      .query(q);
    res.json({ columns: result.recordset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 12. Ejecutar consulta SELECT arbitraria */
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

/** 13. Preguntar a Ollama por una consulta SQL (con debug) */
app.post('/sql/ask-ollama', async (req, res) => {
    const { question, tables = ['Pacientes','Citas'] } = req.body;
  
    try {
      // 1) Leer esquemas igual que antes…
      const p    = await getPool();
      const info = {};
      for (const t of tables) {
        const r = await p.request()
          .input('schema', sql.NVarChar, 'dbo')
          .input('table',  sql.NVarChar, t)
          .query(`
            SELECT COLUMN_NAME, DATA_TYPE
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA=@schema AND TABLE_NAME=@table
          `);
        info[t] = r.recordset
          .map(c => `${c.COLUMN_NAME} (${c.DATA_TYPE})`)
          .join(', ');
      }
  
      // 2) Generar prompt
      const ctx = tables.map(t => `Tabla ${t}: ${info[t]}`).join('\n');
      const prompt = `
  Eres un asistente SQL.
  Estos son los esquemas de las tablas disponibles:
  ${ctx}
  
  Pregunta: ${question}
  
  Devuelve solo la consulta SELECT válida, sin explicación.
      `.trim();
  
      // 3) Ejecutar Ollama y capturar rawOutput
      const rawBuffer = execSync(
        `ollama run llama2 --json --prompt "${prompt.replace(/"/g,'\\"')}"`
      );
      const rawOutput = rawBuffer.toString();
  
      // 4) Intentar parsear JSON
      let modelJson;
      try {
        modelJson = JSON.parse(rawOutput);
      } catch (parseErr) {
        // Si no es JSON, devolvemos rawOutput para debug
        return res.status(500).json({
          error: 'Respuesta de Ollama no es JSON',
          debug: { rawOutput }
        });
      }
  
      // 5) Extraer el texto generado
      let text = modelJson.text
              ?? modelJson.choices?.[0]?.message?.content
              ?? modelJson.choices?.[0]?.text
              ?? '';
      text = text.trim();
  
      // 6) Validar SELECT
      if (!/^select/i.test(text)) {
        return res.status(400).json({
          error: 'Ollama no generó una consulta SELECT válida.',
          debug: { rawOutput, modelJson, generated: text }
        });
      }
  
      // 7) Responder con la consulta y el debug opcional
      return res.json({
        query: text,
        debug: { rawOutput, modelJson }
      });
  
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

// Inicia el servidor HTTP
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`MCP-SQL escuchando en http://localhost:${PORT}`);
});