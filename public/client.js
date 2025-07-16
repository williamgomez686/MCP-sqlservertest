document.addEventListener('DOMContentLoaded', () => {
    // Mapeo de elementos del DOM
    const promptInput = document.getElementById('prompt-input');
    const submitButton = document.getElementById('submit-button');
    const loadingIndicator = document.getElementById('loading-indicator');
    const resultsContainer = document.getElementById('results-container');
    const sqlQueryDisplay = document.getElementById('sql-query-display');
    const resultsTableContainer = document.getElementById('results-table-container');
    const errorMessage = document.getElementById('error-message');

    const apiToken = 'mcp123'; // El mismo token que en tu config.js

    // Evento principal al hacer clic en el botón
    submitButton.addEventListener('click', async () => {
        const question = promptInput.value.trim();
        if (!question) {
            alert('Por favor, ingresa una pregunta.');
            return;
        }

        // 1. Preparar la UI para una nueva solicitud
        uiStartLoading();

        try {
            // 2. Pedir al backend que genere la consulta SQL
            const askResponse = await fetch('/sql/ask-ollama', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-token': apiToken
                },
                body: JSON.stringify({ question })
            });

            if (!askResponse.ok) {
                const errorData = await askResponse.json();
                throw new Error(errorData.error || `Error del servidor: ${askResponse.status}`);
            }

            const { query: sqlQuery } = await askResponse.json();
            sqlQueryDisplay.textContent = sqlQuery;

            // 3. Ejecutar la consulta SQL generada
            const queryResponse = await fetch('/sql/query', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-token': apiToken
                },
                body: JSON.stringify({ sqlText: sqlQuery })
            });

            if (!queryResponse.ok) {
                const errorData = await queryResponse.json();
                throw new Error(errorData.error || `Error al ejecutar la consulta: ${queryResponse.status}`);
            }

            const { rows } = await queryResponse.json();
            
            // 4. Mostrar los resultados
            renderTable(rows);
            uiShowResults();

        } catch (error) {
            // 5. Si algo falla, mostrar el error
            uiShowError(error.message);
        } finally {
            // 6. Terminar el estado de carga
            uiStopLoading();
        }
    });

    // --- Funciones de ayuda para la UI ---

    function uiStartLoading() {
        loadingIndicator.classList.remove('hidden');
        resultsContainer.classList.add('hidden');
        errorMessage.classList.add('hidden');
        submitButton.disabled = true;
    }

    function uiStopLoading() {
        loadingIndicator.classList.add('hidden');
        submitButton.disabled = false;
    }

    function uiShowResults() {
        resultsContainer.classList.remove('hidden');
    }

    function uiShowError(message) {
        errorMessage.textContent = `Error: ${message}`;
        errorMessage.classList.remove('hidden');
    }

    function renderTable(data) {
        resultsTableContainer.innerHTML = ''; // Limpiar tabla anterior
        if (!data || data.length === 0) {
            resultsTableContainer.innerHTML = '<p>La consulta se ejecutó correctamente, pero no devolvió resultados.</p>';
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
                td.textContent = value;
                row.appendChild(td);
            });
            tbody.appendChild(row);
        });

        table.appendChild(thead);
        table.appendChild(tbody);
        resultsTableContainer.appendChild(table);
    }
});
