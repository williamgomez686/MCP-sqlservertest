document.addEventListener('DOMContentLoaded', () => {
    const promptInput = document.getElementById('prompt-input');
    const submitButton = document.getElementById('submit-button');
    const loadingIndicator = document.getElementById('loading-indicator');
    const resultsContainer = document.getElementById('results-container');
    const sqlQueryDisplay = document.getElementById('sql-query-display');
    const resultsTableContainer = document.getElementById('results-table-container');
    const errorMessage = document.getElementById('error-message');

    const apiToken = 'mcp123'; // El mismo token que en tu config.js

    submitButton.addEventListener('click', async () => {
        const question = promptInput.value.trim();
        if (!question) {
            alert('Por favor, ingresa una pregunta.');
            return;
        }

        // Resetear y mostrar el loader
        resultsContainer.classList.add('hidden');
        errorMessage.classList.add('hidden');
        loadingIndicator.classList.remove('hidden');
        submitButton.disabled = true;

        try {
            // 1. Pedir a Ollama que genere la consulta
            const askResponse = await fetch('/sql/ask-ollama', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-token': apiToken
                },
                body: JSON.stringify({ question, tables: ['Pacientes', 'Citas'] })
            });

            if (!askResponse.ok) {
                let errorMsg = 'Error al generar la consulta SQL.';
                try {
                    const errData = await askResponse.json();
                    errorMsg = errData.error || JSON.stringify(errData);
                } catch (e) {
                    errorMsg = await askResponse.text();
                }
                throw new Error(errorMsg);
            }

            const { query: sqlQuery } = await askResponse.json();
            sqlQueryDisplay.textContent = sqlQuery;
            resultsContainer.classList.remove('hidden');

            // 2. Ejecutar la consulta SQL generada
            const queryResponse = await fetch('/sql/query', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-token': apiToken
                },
                body: JSON.stringify({ sqlText: sqlQuery })
            });

            if (!queryResponse.ok) {
                let errorMsg = 'Error al ejecutar la consulta SQL.';
                try {
                    const errData = await queryResponse.json();
                    errorMsg = errData.error || JSON.stringify(errData);
                } catch (e) {
                    errorMsg = await queryResponse.text();
                }
                throw new Error(errorMsg);
            }

            const { rows } = await queryResponse.json();
            renderTable(rows);

        } catch (error) {
            errorMessage.textContent = `Error: ${error.message}`;
            errorMessage.classList.remove('hidden');
            resultsContainer.classList.add('hidden');
        } finally {
            // Ocultar el loader y reactivar el botón
            loadingIndicator.classList.add('hidden');
            submitButton.disabled = false;
        }
    });

    function renderTable(data) {
        resultsTableContainer.innerHTML = '';
        if (!data || data.length === 0) {
            resultsTableContainer.innerHTML = '<p>La consulta no devolvió resultados.</p>';
            return;
        }

        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const tbody = document.createElement('tbody');
        const headerRow = document.createElement('tr');

        // Crear encabezados
        Object.keys(data[0]).forEach(key => {
            const th = document.createElement('th');
            th.textContent = key;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);

        // Crear filas de datos
        data.forEach(rowData => {
            const row = document.createElement('tr');
            Object.values(rowData).forEach(value => {
                const td = document.createElement('td');
                // Formatear fechas si es necesario
                if (typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}T/)) {
                    td.textContent = new Date(value).toLocaleString();
                } else {
                    td.textContent = value;
                }
                row.appendChild(td);
            });
            tbody.appendChild(row);
        });

        table.appendChild(thead);
        table.appendChild(tbody);
        resultsTableContainer.appendChild(table);
    }
});
