module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const action = body.action || 'get_milestones';

  // ── ANÁLISE DE EMOÇÕES ──────────────────────────────────────────
  if (action === 'analyze_sentiment') {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada.' });

    const prompt = `Você é um especialista em análise qualitativa de dados educacionais.
Analise as justificativas dos orientadores do Ismart sobre o avanço dos estudantes nas competências trabalhadas.

TEXTOS:
${body.texts}

Responda APENAS com um JSON válido, sem explicações, sem markdown, nesse formato exato:
{"tom":{"emoji":"<emoji>","titulo":"<título curto, ex: Positivo>","descricao":"<1 frase, máx 80 caracteres>"},"tensao":{"emoji":"<emoji>","titulo":"<tema, ex: Gestão de tempo>","descricao":"<1 frase, máx 80 caracteres>"},"orgulho":{"emoji":"<emoji>","titulo":"<tema, ex: Vínculo e escuta>","descricao":"<1 frase, máx 80 caracteres>"}}`;

    try {
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 600,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const aiData = await aiRes.json();
      const text = (aiData.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      return res.status(200).json({ analysis: text });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── OBSERVAÇÕES (autoavaliação + observador) ────────────────────
  if (action === 'get_observacoes') {
    const sheetsKey = process.env.GOOGLE_SHEETS_API_KEY;
    if (!sheetsKey) return res.status(500).json({ error: 'GOOGLE_SHEETS_API_KEY não configurada.' });

    const ID_AUTOAV = '113U9ZakL5fciaRXOd8JrxTbZzDmYdDRFHmana4xN3Ns';
    const ID_OBS    = '1s9vVGtBesBhQFD3WS5K3m12f-QYPpPYjx8OZpy-aAes';

    // Mapeamento escola → praça (adicione novas escolas aqui conforme necessário)
    const ESCOLA_PRACA = {
      'são bento': 'RJ', 'sao bento': 'RJ',
      'magnum': 'BH',
      'santo antônio': 'BH', 'santo antonio': 'BH',
      'rio branco granja viana': 'SP', 'rio branco': 'SP',
      'móbile': 'SP', 'mobile': 'SP',
      'poliedro': 'SJC', 'objetivo': 'SJC'
    };

    function getPraca(escola) {
      const key = (escola || '').toLowerCase().trim();
      for (const [k, v] of Object.entries(ESCOLA_PRACA)) {
        if (key.includes(k)) return v;
      }
      return '—';
    }

    // Extrai número do início de "4 – Avançado: ..." ou "3 – Proficiente: ..."
    function parseScore(txt) {
      if (!txt) return null;
      const m = /^(\d+)/.exec(txt.trim());
      return m ? parseInt(m[1]) : null;
    }

    // Identifica colunas de pilares pelo header (contém ponto, ex: "1.1", "2.3")
    function getPilarIndexes(headers) {
      return headers.reduce((acc, h, i) => {
        if (/\d+\.\d+/.test(h)) acc.push(i);
        return acc;
      }, []);
    }

    function calcMedia(row, pilarIdxs) {
      const scores = pilarIdxs.map(i => parseScore(row[i])).filter(n => n !== null);
      if (scores.length === 0) return null;
      return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
    }

    function findCol(headers, keywords) {
      return headers.findIndex(h =>
        keywords.some(kw => h.toLowerCase().includes(kw.toLowerCase()))
      );
    }

    async function fetchSheet(id) {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/A1:Z500?key=${sheetsKey}`;
      const r = await fetch(url);
      const d = await r.json();
      return d.values || [];
    }

    try {
      const [rawAutoav, rawObs] = await Promise.all([
        fetchSheet(ID_AUTOAV),
        fetchSheet(ID_OBS)
      ]);

      if (rawAutoav.length < 2 || rawObs.length < 2) {
        return res.status(200).json({ orientadores: [] });
      }

      const headAutoav = rawAutoav[0].map(h => h.trim());
      const headObs    = rawObs[0].map(h => h.trim());

      // Colunas chave — autoavaliação
      const iNomeAutoav = findCol(headAutoav, ['insira seu nome', 'nome', 'orientador']);
      const iEscolaAutoav = findCol(headAutoav, ['escola']);
      const iSerieAutoav  = findCol(headAutoav, ['série', 'serie']);
      const iCicloAutoav  = findCol(headAutoav, ['ciclo']);
      const pilaresAutoav = getPilarIndexes(headAutoav);

      // Colunas chave — observador
      const iNomeObs    = findCol(headObs, ['orientador observado', 'orientador', 'nome']);
      const iEscolaObs  = findCol(headObs, ['escola']);
      const iSerieObs   = findCol(headObs, ['série', 'serie']);
      const iCicloObs   = findCol(headObs, ['ciclo']);
      const pilaresObs  = getPilarIndexes(headObs);

      // Monta mapa de autoavaliações por chave
      const autoavMap = {};
      for (const row of rawAutoav.slice(1)) {
        const nome  = (row[iNomeAutoav] || '').trim();
        const esc   = (row[iEscolaAutoav] || '').trim();
        const serie = (row[iSerieAutoav] || '').trim();
        const ciclo = (row[iCicloAutoav] || '').trim();
        if (!nome) continue;
        const chave = `${nome}|${esc}|${serie}|${ciclo}`.toLowerCase();
        const media = calcMedia(row, pilaresAutoav);
        // Guarda a entrada mais recente
        if (!autoavMap[chave] || media !== null) {
          autoavMap[chave] = { nome, escola: esc, serie, ciclo, autoav: media };
        }
      }

      // Monta mapa de observações por chave (média de múltiplas observações)
      const obsMap = {};
      for (const row of rawObs.slice(1)) {
        const nome  = (row[iNomeObs] || '').trim();
        const esc   = (row[iEscolaObs] || '').trim();
        const serie = (row[iSerieObs] || '').trim();
        const ciclo = (row[iCicloObs] || '').trim();
        if (!nome) continue;
        const chave = `${nome}|${esc}|${serie}|${ciclo}`.toLowerCase();
        const score = calcMedia(row, pilaresObs);
        if (score !== null) {
          if (!obsMap[chave]) obsMap[chave] = [];
          obsMap[chave].push(score);
        }
      }

      // Cruza os dois mapas
      const resultado = Object.entries(autoavMap).map(([chave, a]) => {
        const obsScores = obsMap[chave] || [];
        const obsMedia = obsScores.length > 0
          ? Math.round((obsScores.reduce((x, y) => x + y, 0) / obsScores.length) * 10) / 10
          : null;
        const mediaFinal = obsMedia !== null
          ? Math.round(((a.autoav || 0) + obsMedia) / 2 * 10) / 10
          : a.autoav;
        return {
          nome: a.nome,
          escola: a.escola,
          praca: getPraca(a.escola),
          serie: a.serie,
          ciclo: a.ciclo,
          autoav: a.autoav,
          obs: obsMedia,
          media: mediaFinal,
          apenasAutoav: obsMedia === null
        };
      });

      // Ordena por média decrescente
      resultado.sort((a, b) => (b.media || 0) - (a.media || 0));

      return res.status(200).json({ orientadores: resultado });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── FEEDBACK ALUNOS (por série/ciclo) ───────────────────────────
  if (action === 'get_feedback_alunos') {
    const sheetsKey = process.env.GOOGLE_SHEETS_API_KEY;
    if (!sheetsKey) return res.status(500).json({ error: 'GOOGLE_SHEETS_API_KEY não configurada.' });

    const SHEETS = [
      { id: '1jxBS2ISCFYkLqM7Su0SBP7dJUbfi9N6plXwWWsHjEYk', serie: '1ºEM', ciclo: 'C1' },
      { id: '10joUR_7AY2udwvSgrZLq7sYQTbl0Tj9s0jpTeot_soQ', serie: '1ºEM', ciclo: 'C2' },
      { id: '1BH39N32YFrx_duEcunXRy6ktuOkyS0f2g5z0T5QIuNA', serie: '2ºEM', ciclo: 'C1' },
      { id: '1eyJZziZL0GFnYreJqE5iy07Z087yIbPI6y-MNrjQ6zY', serie: '2ºEM', ciclo: 'C2' },
      { id: '1v4cDuh06cTt36ShqpbJajY1I1wKfXGgOIqU9YIAr6ig', serie: '3ºEM', ciclo: 'C1' },
      { id: '1DB0hSzQQqYqPRSzlGIPbhuXqQUFrOc8IRUZsuxeeA3A', serie: '3ºEM', ciclo: 'C2' }
    ];

    async function fetchSheet(id) {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/A1:Z500?key=${sheetsKey}`;
      const r = await fetch(url);
      return r.json();
    }

    function parseRating(txt) {
      if (!txt) return null;
      // Aceita formatos: "4", "4 - ...", "4 estrelas", número puro
      const m = /^(\d+)/.exec(txt.trim());
      const n = m ? parseInt(m[1]) : null;
      return (n >= 1 && n <= 5) ? n : null;
    }

    try {
      const results = await Promise.all(SHEETS.map(async s => {
        try {
          const d = await fetchSheet(s.id);
          const rows = d.values || [];
          if (rows.length < 2) return { ...s, respostas: 0, media: null };

          const headers = rows[0].map(h => (h || '').toLowerCase());
          // Procura coluna de nota: "nota", "avalia", "estrela", "satisfa", "como foi"
          let ratingIdx = headers.findIndex(h =>
            h.includes('nota') || h.includes('avalia') || h.includes('estrela') ||
            h.includes('satisfa') || h.includes('como foi') || h.includes('como você')
          );

          // Fallback: coluna com mais valores numéricos entre 1-5
          if (ratingIdx === -1) {
            let bestCol = -1, bestCount = 0;
            for (let ci = 1; ci < (rows[0] || []).length; ci++) {
              const count = rows.slice(1).filter(r => parseRating(r[ci]) !== null).length;
              if (count > bestCount) { bestCount = count; bestCol = ci; }
            }
            if (bestCount > rows.length * 0.3) ratingIdx = bestCol;
          }

          if (ratingIdx === -1) return { ...s, respostas: 0, media: null };

          const scores = rows.slice(1)
            .map(r => parseRating(r[ratingIdx]))
            .filter(n => n !== null);

          if (scores.length === 0) return { ...s, respostas: 0, media: null };

          const media = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10;
          return { ...s, respostas: scores.length, media };
        } catch(_) {
          return { ...s, respostas: 0, media: null };
        }
      }));

      return res.status(200).json({ feedback: results });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── VOZES DOS ALUNOS ────────────────────────────────────────────
  if (action === 'get_vozes_alunos') {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const sheetsKey = process.env.GOOGLE_SHEETS_API_KEY;
    if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada.' });

    const sheetIds = [
      { id: '1jxBS2ISCFYkLqM7Su0SBP7dJUbfi9N6plXwWWsHjEYk', serie: '1ºEM', ciclo: 'C1' },
      { id: '10joUR_7AY2udwvSgrZLq7sYQTbl0Tj9s0jpTeot_soQ', serie: '1ºEM', ciclo: 'C2' },
      { id: '1BH39N32YFrx_duEcunXRy6ktuOkyS0f2g5z0T5QIuNA', serie: '2ºEM', ciclo: 'C1' },
      { id: '1eyJZziZL0GFnYreJqE5iy07Z087yIbPI6y-MNrjQ6zY', serie: '2ºEM', ciclo: 'C2' },
      { id: '1v4cDuh06cTt36ShqpbJajY1I1wKfXGgOIqU9YIAr6ig', serie: '3ºEM', ciclo: 'C1' },
      { id: '1DB0hSzQQqYqPRSzlGIPbhuXqQUFrOc8IRUZsuxeeA3A', serie: '3ºEM', ciclo: 'C2' }
    ];

    const linhas = [];

    if (sheetsKey) {
      // Fetch sequencial para não estourar quota
      for (const s of sheetIds) {
        try {
          const url = `https://sheets.googleapis.com/v4/spreadsheets/${s.id}/values/A1:Z1000?key=${sheetsKey}`;
          const r = await fetch(url);
          const d = await r.json();
          const rows = d.values || [];
          if (rows.length < 2) continue;

          const header = rows[0].map(h => (h || '').toLowerCase());

          // Coluna do comentário aberto
          const iComent = header.findIndex(h =>
            h.includes('espaço livre') || h.includes('comentário') || h.includes('dúvida') || h.includes('livre')
          );
          if (iComent === -1) continue;

          // Coluna da praça (para identificar origem de cada resposta)
          const iPraca = header.findIndex(h => h.includes('praça') || h.includes('praca'));

          for (const row of rows.slice(1)) {
            const txt = (row[iComent] || '').trim();
            if (txt.length < 15) continue;
            const praca = iPraca !== -1 ? (row[iPraca] || '').trim() : '';
            // Abrevia praça
            const pracaAbrev = praca.toLowerCase().includes('são paulo') || praca.toLowerCase().includes('sp') ? 'SP'
              : praca.toLowerCase().includes('belo') || praca.toLowerCase().includes('bh') ? 'BH'
              : praca.toLowerCase().includes('rio') || praca.toLowerCase().includes('rj') ? 'RJ'
              : praca.toLowerCase().includes('josé') || praca.toLowerCase().includes('sjc') ? 'SJC'
              : praca || '?';
            linhas.push(`[${pracaAbrev} · ${s.serie} · ${s.ciclo}] ${txt}`);
          }
        } catch(_) {}
      }
    }

    const textos = linhas.length > 0
      ? linhas.join('\n')
      : '[dados das planilhas não disponíveis — use comentários fictícios representativos de alunos do Ensino Médio em programa de desenvolvimento pessoal]';

    const prompt = `Você é analista de dados educacionais do Ismart.
Analise TODOS os comentários abertos de alunos do Ensino Médio do programa PDEB 2026 listados abaixo.

PASSO 1 — Classificação completa:
Classifique CADA comentário válido (com mais de 10 caracteres) como exatamente uma categoria:
- "positivo": expressões de satisfação, aprendizado, impacto pessoal
- "critica": insatisfação, dificuldade, algo que não funcionou
- "melhoria": sugestão construtiva de mudança ou adição

PASSO 2 — Percentuais reais:
Conte o total de comentários válidos classificados.
Calcule a porcentagem exata de cada categoria (arredondada). Os três devem somar 100.

PASSO 3 — Seleção de 12:
Selecione exatamente 4 comentários representativos de cada categoria.
- Corrija ortografia, pontuação e capitalização
- Mantenha o sentido original
- Cada comentário entre 15 e 120 caracteres
- Extraia praça e série da tag (ex: [SP · 1ºEM · C1] → praca: "SP", serie: "1ºEM")
- Se faltar comentários reais numa categoria, complete com exemplos verossímeis

Responda APENAS com JSON válido, sem markdown, sem texto antes ou depois:
{
  "total_comentarios": 209,
  "percentuais": { "positivos": 62, "criticas": 18, "melhorias": 20 },
  "comentarios": [
    {"texto": "...", "praca": "SP", "serie": "1ºEM", "categoria": "positivo"},
    {"texto": "...", "praca": "BH", "serie": "2ºEM", "categoria": "critica"}
  ]
}

COMENTÁRIOS:
${textos}`;

    try {
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1200,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const aiData = await aiRes.json();
      const text = (aiData.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      return res.status(200).json({ vozes: text });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── PRAÇAS CICLO 2 (oficinas + fala aí) ─────────────────────────
  if (action === 'get_pracas_c2') {
    const sheetsKey = process.env.GOOGLE_SHEETS_API_KEY;
    if (!sheetsKey) return res.status(500).json({ error: 'GOOGLE_SHEETS_API_KEY não configurada.' });

    const SHEETS = {
      SP:  '1anki0VweR8LweziQkN-KDTJbklAp9asfdxtU5JhkMhk',
      BH:  '14uStnQL61Yu4xQJTGpmBt5d9d_s5681i8MAdLUkAnTg',
      RJ:  '1TsCj4_MqfIWCZF8j30E_hnpw8z3nDz8Ph5lMIXZEAuc',
      SJC: '1xBgYIGMjGDFyOS1VVu62RGciDoSNZNSy9ZtOFjEUjHc'
    };

    const SERIES_GERAL = ['8ef','9ef','1em','2em'];
    const SERIES_3EM   = ['3em'];

    function normSerie(s) {
      return (s || '').toLowerCase()
        .replace(/[°º˚]/g, '')   // remove ordinal/degree
        .replace(/\s+/g, '')     // remove espaços
        .replace(/[^a-z0-9]/g, ''); // remove outros chars
    }

    function matchSerie(turma, grupo) {
      const t = normSerie(turma);
      return grupo.some(s => t.includes(normSerie(s)));
    }

    function calcPct(rows, iturma, iofic, ifa, grupo) {
      const filtrado = rows.filter(r => matchSerie(r[iturma], grupo));
      if (filtrado.length === 0) return { oficinas: null, falaAi: null };
      const ofic = filtrado.filter(r => (r[iofic] || '').toLowerCase().includes('realizada') && !(r[iofic] || '').toLowerCase().includes('não')).length;
      const fa   = filtrado.filter(r => (r[ifa]   || '').toLowerCase().includes('realizado') && !(r[ifa]   || '').toLowerCase().includes('não')).length;
      return {
        oficinas: Math.round(ofic / filtrado.length * 1000) / 10,
        falaAi:   Math.round(fa   / filtrado.length * 1000) / 10
      };
    }

    try {
      const resultado = {};
      const debugInfo = {};

      await Promise.all(Object.entries(SHEETS).map(async ([praca, id]) => {
        try {
          // Nome da aba confirmado como "Dados" em todas as planilhas de presença
          const aba = 'Dados';
          const url  = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(aba + '!A1:Z2000')}?key=${sheetsKey}`;
          const r    = await fetch(url);
          const d    = await r.json();
          const rows = d.values || [];

          if (rows.length < 2) {
            debugInfo[praca] = { aba, error: 'menos de 2 linhas', totalRows: rows.length };
            resultado[praca] = { geral: { oficinas: null, falaAi: null }, em3: { oficinas: null, falaAi: null } };
            return;
          }

          // Estrutura de 2 linhas de cabeçalho:
          // Linha 0: "Informações Gerais", ..., "Ciclo 1", "", "Ciclo 2", "", "Ciclo 3", ...
          // Linha 1: "Aluno", "Turma", ..., "Oficina", "Fala Aí", "Oficina", "Fala Aí", ...

          const row0 = rows[0].map(h => (h || '').toLowerCase().trim());
          const row1 = rows[1] ? rows[1].map(h => (h || '').toLowerCase().trim()) : [];

          // Encontra índice do Ciclo 2 na linha 0
          const ciclo2Start = row0.findIndex(h => h.includes('ciclo 2') || h === 'ciclo2');

          // Encontra coluna Turma — pode estar na linha 0 ou 1
          let iturma = row0.findIndex(h => h.includes('turma'));
          if (iturma === -1) iturma = row1.findIndex(h => h.includes('turma'));

          // Dentro do bloco Ciclo 2: primeira coluna = Oficina, segunda = Fala Aí
          let iofic = -1, ifa = -1;
          if (ciclo2Start !== -1) {
            // Confirma pela linha 1 quais são oficina e fala aí nesse bloco
            for (let c = ciclo2Start; c < ciclo2Start + 3 && c < row1.length; c++) {
              if (row1[c] && row1[c].includes('oficina') && iofic === -1) iofic = c;
              if (row1[c] && (row1[c].includes('fala') || row1[c].includes('fa ')) && ifa === -1) ifa = c;
            }
            // Fallback: Ciclo 2 ocupa colunas ciclo2Start e ciclo2Start+1
            if (iofic === -1) iofic = ciclo2Start;
            if (ifa   === -1) ifa   = ciclo2Start + 1;
          }

          debugInfo[praca] = { ciclo2Start, iturma, iofic, ifa, row0: row0.slice(0,10), row1: row1.slice(0,10) };

          if (iturma === -1 || ciclo2Start === -1) {
            resultado[praca] = { geral: { oficinas: null, falaAi: null }, em3: { oficinas: null, falaAi: null } };
            return;
          }

          // Dados começam na linha 2 (após os dois cabeçalhos)
          const data = rows.slice(2);
          resultado[praca] = {
            geral: calcPct(data, iturma, iofic, ifa, SERIES_GERAL),
            em3:   calcPct(data, iturma, iofic, ifa, SERIES_3EM)
          };
        } catch(e) {
          debugInfo[praca] = { error: e.message };
          resultado[praca] = { geral: { oficinas: null, falaAi: null }, em3: { oficinas: null, falaAi: null } };
        }
      }));

      return res.status(200).json({ pracas: resultado, _debug: debugInfo });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── DADOS DO GOOGLE SHEETS ──────────────────────────────────────
  if (action === 'get_sheets_data') {
    const sheetsKey = process.env.GOOGLE_SHEETS_API_KEY;
    if (!sheetsKey) {
      return res.status(500).json({
        error: 'GOOGLE_SHEETS_API_KEY não configurada. Acesse Vercel → Settings → Environment Variables e adicione a chave da API do Google.'
      });
    }

    const sheetIds = {
      dados_semanais: '1A_AP1pUt5f-wwoFyhEWuzn1zt2O1baIhLsH5oZjE4Fc',
      presenca_bh:    '14uStnQL61Yu4xQJTGpmBt5d9d_s5681i8MAdLUkAnTg',
      presenca_sp:    '1anki0VweR8LweziQkN-KDTJbklAp9asfdxtU5JhkMhk',
      presenca_rj:    '1TsCj4_MqfIWCZF8j30E_hnpw8z3nDz8Ph5lMIXZEAuc',
      presenca_sjc:   '1xBgYIGMjGDFyOS1VVu62RGciDoSNZNSy9ZtOFjEUjHc'
    };

    async function fetchSheet(sheetId, range) {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?key=${sheetsKey}`;
      const r = await fetch(url);
      return r.json();
    }

    try {
      // Puxa aba Dashboard da planilha principal
      const dashboard = await fetchSheet(sheetIds.dados_semanais, 'Dashboard!A1:Z50');
      const ciclo1Det = await fetchSheet(sheetIds.dados_semanais, 'Ciclo 1 - Detalhes!A1:Z100');
      const ciclo2Det = await fetchSheet(sheetIds.dados_semanais, 'Ciclo 2 - Detalhes!A1:Z100');

      return res.status(200).json({
        updatedAt: new Date().toLocaleDateString('pt-BR'),
        dashboard: dashboard.values || [],
        ciclo1_detalhes: ciclo1Det.values || [],
        ciclo2_detalhes: ciclo2Det.values || []
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── DADOS DO MONDAY ─────────────────────────────────────────────
  const mondayToken = process.env.MONDAY_API_TOKEN;
  if (!mondayToken) {
    return res.status(500).json({ error: 'MONDAY_API_TOKEN não configurado.' });
  }

  try {
    const mondayRes = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': mondayToken,
        'API-Version': '2024-01'
      },
      body: JSON.stringify({
        query: `{
          boards(ids: [18404519367]) {
            items_page(limit: 50) {
              items {
                id
                name
                column_values { id text }
                subitems {
                  id
                  name
                  column_values { id text }
                }
              }
            }
          }
        }`
      })
    });

    const data = await mondayRes.json();
    if (data.errors) return res.status(400).json({ error: data.errors[0].message });

    const items = data?.data?.boards?.[0]?.items_page?.items || [];
    const marcoItems = items.filter(i => /^M[1-5]\s/i.test(i.name));

    const grouped = {};
    for (const item of marcoItems) {
      const key = item.name.substring(0, 2).toUpperCase();
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(item);
    }

    const STATUS_VALUES = ['Feito', 'Em andamento', 'Congelado', 'Não iniciado'];
    function findStatus(column_values) {
      const byId = column_values.find(c => c.id === 'color_mm1jjjjy' || c.id === 'status');
      if (byId?.text && STATUS_VALUES.includes(byId.text)) return byId.text;
      const byValue = column_values.find(c => STATUS_VALUES.includes(c.text));
      return byValue?.text || 'Não iniciado';
    }

    function parseMarco(item) {
      const status = findStatus(item.column_values);
      const subitems = (item.subitems || []).map(sub => {
        return { nome: sub.name, status: findStatus(sub.column_values) };
      });
      const done = subitems.filter(s => s.status === 'Feito').length;
      const total = subitems.length || 1;
      return {
        id: item.name.substring(0, 2).toUpperCase(),
        nome: item.name.replace(/^M[1-5]\s[-–]\s?/i, ''),
        status,
        acomp: Math.round((done / total) * 100),
        done,
        total,
        subitems
      };
    }

    const ciclo1 = ['M1','M2','M3','M4','M5'].filter(k => grouped[k]?.[0]).map(k => parseMarco(grouped[k][0]));
    const ciclo2 = ['M1','M2','M3','M4','M5'].filter(k => grouped[k]?.[1]).map(k => parseMarco(grouped[k][1]));

    return res.status(200).json({
      updatedAt: new Date().toLocaleDateString('pt-BR'),
      ciclo1,
      ciclo2
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
