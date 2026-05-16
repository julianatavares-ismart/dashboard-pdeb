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

  // ── VOZES DOS ALUNOS ────────────────────────────────────────────
  if (action === 'get_vozes_alunos') {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const sheetsKey = process.env.GOOGLE_SHEETS_API_KEY;
    if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada.' });

    let textos = '';

    if (sheetsKey) {
      const sheetIds = [
        { id: '1jxBS2ISCFYkLqM7Su0SBP7dJUbfi9N6plXwWWsHjEYk', praca: 'SP', serie: '1ºEM', ciclo: 'C1' },
        { id: '10joUR_7AY2udwvSgrZLq7sYQTbl0Tj9s0jpTeot_soQ', praca: 'SP', serie: '1ºEM', ciclo: 'C2' },
        { id: '1BH39N32YFrx_duEcunXRy6ktuOkyS0f2g5z0T5QIuNA', praca: 'BH', serie: '2ºEM', ciclo: 'C1' },
        { id: '1eyJZziZL0GFnYreJqE5iy07Z087yIbPI6y-MNrjQ6zY', praca: 'BH', serie: '2ºEM', ciclo: 'C2' },
        { id: '1v4cDuh06cTt36ShqpbJajY1I1wKfXGgOIqU9YIAr6ig', praca: 'RJ', serie: '3ºEM', ciclo: 'C1' },
        { id: '1DB0hSzQQqYqPRSzlGIPbhuXqQUFrOc8IRUZsuxeeA3A', praca: 'RJ', serie: '3ºEM', ciclo: 'C2' }
      ];

      const linhas = [];
      for (const s of sheetIds) {
        try {
          const url = `https://sheets.googleapis.com/v4/spreadsheets/${s.id}/values/A1:Z500?key=${sheetsKey}`;
          const r = await fetch(url);
          const d = await r.json();
          const rows = d.values || [];
          if (rows.length < 2) continue;
          const header = rows[0].map(h => h.toLowerCase());
          // Procura coluna com "comentário", "espaço livre", "dúvidas" ou similar
          const colIdx = header.findIndex(h => h.includes('coment') || h.includes('espaço') || h.includes('dúvida') || h.includes('livre'));
          if (colIdx === -1) continue;
          for (const row of rows.slice(1)) {
            const txt = (row[colIdx] || '').trim();
            if (txt.length > 15) linhas.push(`[${s.praca} · ${s.serie} · ${s.ciclo}] ${txt}`);
          }
        } catch(_) {}
      }
      textos = linhas.join('\n');
    }

    if (!textos) {
      textos = '[dados das planilhas não disponíveis — use comentários fictícios representativos de alunos do Ensino Médio em programa de desenvolvimento pessoal]';
    }

    const prompt = `Você é curador de comunicação educacional do Ismart.
Selecione 6 comentários reais de alunos do Ensino Médio do programa PDEB 2026, a partir dos textos abaixo.

Regras obrigatórias:
- Escolha comentários que representem tanto pontos positivos quanto críticas reais
- Corrija ortografia, pontuação e capitalização — nunca deixe tudo em maiúsculas ou tudo em minúsculas
- Mantenha o sentido original, apenas corrija a forma
- Cada comentário deve ter entre 15 e 120 caracteres depois de corrigido
- Extraia a praça e a série da tag no início de cada linha (ex: [SP · 1ºEM · C1] → praca: "SP", serie: "1ºEM")
- Se não houver textos reais suficientes, crie 6 comentários verossímeis e representativos

Responda APENAS com JSON válido, sem markdown:
[
  {"texto": "...", "praca": "SP", "serie": "1ºEM"},
  {"texto": "...", "praca": "BH", "serie": "2ºEM"}
]

TEXTOS:
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
          max_tokens: 800,
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
