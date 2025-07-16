// server.js
const express      = require('express');
const bodyParser   = require('body-parser');
const fs           = require('fs').promises;
const path         = require('path');
const sql          = require('mssql');
const { execSync } = require('child_process');
const { db, apiToken, openRouterApiKey } = require('./config');

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));    // Sirve UI desde public/

/** Middleware de autenticación */
app.use((req, res, next) => {
  if (req.headers['x-api-token'] !== apiToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

/** Helper: conecta a SQL Server con pool global */
let pool;
async function getPool() {
  if (!pool) pool = await sql.connect(db);
  return pool;
}

/** Endpoints de archivos (list, read, move, copy, delete, stat, grep, write) */
app.post('/browse', async (req, res) => {
  try {
    const items = await fs.readdir(req.body.folder, { withFileTypes: true });
    res.json({
      folders: items.filter(i => i.isDirectory()).map(i => i.name),
      files:   items.filter(i => i.isFile()).map(i => i.name)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/list',  async (req, res) => { try { res.json({ items: await fs.readdir(req.body.folder) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/read',  async (req, res) => { try {
    res.json({ content: await fs.readFile(req.body.path, 'utf8') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/move',  async (req, res) => { try {
    await fs.rename(req.body.src, req.body.dest);
    res.json({ moved: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/copy',  async (req, res) => { try {
    await fs.copyFile(req.body.src, req.body.dest);
    res.json({ copied: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/delete',async (req, res) => { try {
    await fs.unlink(req.body.path);
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/stat',  async (req, res) => { try {
    const info = await fs.stat(req.body.path);
    res.json({
      size: info.size,
      created: info.birthtime,
      modified: info.mtime,
      isFile: info.isFile(),
      isDirectory: info.isDirectory()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/grep',  async (req, res) => { try {
    const { folder, pattern } = req.body;
    const regex = new RegExp(pattern, 'i');
    const files = await fs.readdir(folder);
    const matches = [];
    for (const f of files) {
      if (/\.txt$/i.test(f)) {
        const txt = await fs.readFile(path.join(folder, f), 'utf8');
        if (regex.test(txt)) matches.push(f);
      }
    }
    res.json({ matches });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/write', async (req, res) => { try {
    await fs.writeFile(req.body.path, req.body.content || '');
    res.json({ written: true, path: req.body.path });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Endpoints SQL Server **/

// 1) Listar tablas
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

// 2) Describir columnas
app.post('/sql/describe', async (req, res) => {
  try {
    const { schema, table } = req.body;
    const p = await getPool();
    const result = await p.request()
      .input('schema', sql.NVarChar, schema)
      .input('table',  sql.NVarChar, table)
      .query(`
        SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=@schema AND TABLE_NAME=@table
      `);
    res.json({ columns: result.recordset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3) Ejecutar SELECT arbitrario
app.post('/sql/query', async (req, res) => {
  try {
    const { sqlText } = req.body;
    if (!/^select/i.test(sqlText)) {
      return res.status(400).json({ error: 'Solo se permiten SELECT.' });
    }
    const p = await getPool();
    const result = await p.request().query(sqlText);
    res.json({ rows: result.recordset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4) Preguntar a un modelo de IA (OpenRouter) para generar SQL
app.post('/sql/ask-ollama', async (req, res) => {
    const { question, tables = ['Pacientes', 'Citas', 'EstadosCita', 'Consultas', 'Profesionales', 'Empleados'] } = req.body;
  
    try {
      // Paso 1: Obtener los esquemas de las tablas (sin cambios)
      const p = await getPool();
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
  
      // --- INICIO DE LA SECCIÓN MODIFICADA: USO DE OPENROUTER ---
  
      // Paso 2: Construir el prompt en formato de mensajes (estilo OpenAI)
      const tableSchemas = tables.map(t => `Tabla ${t}: ${info[t]}`).join('\n');
      const systemPrompt = `Eres un asistente experto en T-SQL. Basado en los esquemas de tablas proporcionados, genera una consulta para responder a la pregunta del usuario. Tu respuesta DEBE ser únicamente un objeto JSON con una sola clave "query".`;
      const userPrompt = `Esquemas:\n${tableSchemas}\n\nPregunta: "${question}"\n\nJSON de respuesta:`;

      // Paso 3: Preparar el payload para la API de OpenRouter
      const payload = {
        model: "deepseek/deepseek-chat-v3-0324:free", // Un modelo potente y gratuito de OpenRouter
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        response_format: { "type": "json_object" } // Pedimos explícitamente un JSON
      };

      // Paso 4: Llamar a la API de OpenRouter
      const openRouterEndpoint = 'https://openrouter.ai/api/v1/chat/completions';
      const response = await fetch(openRouterEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openRouterApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(300000) // Mantenemos el timeout largo
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`La API de OpenRouter respondió con el estado ${response.status}: ${errorText}`);
      }

      const openRouterData = await response.json();
      
      // La respuesta de OpenRouter ya contiene el JSON parseado en la ruta correcta
      let finalJson;
      try {
        finalJson = JSON.parse(openRouterData.choices[0].message.content);
      } catch (e) {
        return res.status(500).json({
          error: 'OpenRouter no devolvió un string con formato JSON válido en su respuesta.',
          rawOutputFromOpenRouter: openRouterData.choices[0].message.content
        });
      }
  
      // Paso 5: Validar y devolver la consulta
      console.log('Respuesta JSON de Ollama:', JSON.stringify(finalJson, null, 2)); // Log para depuración

      const queryValue = finalJson.query;
      if (typeof queryValue !== 'string') {
        return res.status(500).json({
          error: 'La respuesta de Ollama no contenía una propiedad "query" de tipo string. Revisa la consola del servidor para ver la respuesta completa.',
          responseObject: finalJson
        });
      }

      // Limpiar la consulta: algunos modelos envuelven el SQL en llaves.
      const query = queryValue.replace(/^{|}$/g, '').trim();
      if (!/^select/i.test(query)) {
        return res.status(400).json({
          error: 'El JSON generado no contiene una consulta SELECT válida.',
          responseObject: finalJson
        });
      }
  
      res.json({ query }); // Enviamos solo la consulta al cliente
  
      // --- FIN DE LA SECCIÓN MODIFICADA ---
  
    } catch (err) {
      // Este catch ahora atrapará errores de SQL, de la red (fetch), o de la API
      console.error(err); // Es bueno registrar el error completo en el servidor
      res.status(500).json({ error: err.message });
    }
  });

// Iniciar servidor
const port = process.env.PORT || 3001;
app.listen(port, '0.0.0.0', () => {
  console.log(`MCP-SQL escuchando en http://localhost:${port}`);
});