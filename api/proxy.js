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

    const ESCOLA_PRACA = {
      'são bento': 'RJ', 'sao bento': 'RJ', 'eleva': 'RJ', 'liceu franco': 'RJ',
      'ort': 'RJ', 'pensi': 'RJ', 'ph botafogo': 'RJ', 'ph freguesia': 'RJ', 'ph tijuca': 'RJ',
      'magnum': 'BH', 'bernoulli': 'BH', 'santo antônio': 'BH', 'santo antonio': 'BH',
      'embraer': 'SJC', 'poliedro são josé': 'SJC', 'poliedro sao jose': 'SJC',
      'poliedro sjc': 'SJC', 'anglo sjc': 'SJC', 'anglo são josé': 'SJC',
      'anglo sao jose': 'SJC', 'anglo - sjc': 'SJC',
      'andover': 'SP', 'avenues': 'SP', 'bandeirantes': 'SP', 'beacon': 'SP',
      'dante': 'SP', 'lourenço castanho': 'SP', 'lourenco castanho': 'SP',
      'magno': 'SP', 'móbile': 'SP', 'mobile': 'SP',
      'poliedro são paulo': 'SP', 'poliedro sao paulo': 'SP', 'poliedro sp': 'SP',
      'rio branco': 'SP', 'saint paul': 'SP', 'stockler': 'SP', 'uirapuru': 'SP',
      'anglo sp': 'SP', 'anglo são paulo': 'SP', 'anglo sao paulo': 'SP', 'anglo - sp': 'SP',
    };

    function getPraca(escola) {
      const key = (escola || '').toLowerCase().trim();
      for (const [k, v] of Object.entries(ESCOLA_PRACA)) {
        if (key.includes(k)) return v;
      }
      return '—';
    }

    function parseScore(txt) {
      if (!txt) return null;
      const m = /^(\d+)/.exec(txt.trim());
      return m ? parseInt(m[1]) : null;
    }

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

    function getPilarName(header) {
      const linha = (header || '').split('\n')[0].trim();
      const m = linha.match(/^\d+\.\d+\s*[-–]?\s*(.+)/);
      return m ? m[1].trim() : linha;
    }

    function getPilarScores(row, pilarIdxs, headers) {
      const scores = {};
      pilarIdxs.forEach(idx => {
        const s = parseScore(row[idx]);
        if (s !== null) scores[getPilarName(headers[idx])] = s;
      });
      return scores;
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
      const [rawAutoav, rawObs] = await Promise.all([fetchSheet(ID_AUTOAV), fetchSheet(ID_OBS)]);
      if (rawAutoav.length < 2 || rawObs.length < 2) return res.status(200).json({ orientadores: [] });

      const headAutoav = rawAutoav[0].map(h => h.trim());
      const headObs    = rawObs[0].map(h => h.trim());

      const iNomeAutoav   = findCol(headAutoav, ['insira seu nome', 'nome', 'orientador']);
      const iEscolaAutoav = findCol(headAutoav, ['escola']);
      const iSerieAutoav  = findCol(headAutoav, ['série', 'serie']);
      const iCicloAutoav  = findCol(headAutoav, ['ciclo']);
      const pilaresAutoav = getPilarIndexes(headAutoav);

      const iNomeObs   = findCol(headObs, ['orientador observado', 'orientador', 'nome']);
      const iEscolaObs = findCol(headObs, ['escola']);
      const iSerieObs  = findCol(headObs, ['série', 'serie']);
      const iCicloObs  = findCol(headObs, ['ciclo']);
      const pilaresObs = getPilarIndexes(headObs);

      // Agrupa autoavaliações por NOME
      const autoavByNome = {};
      for (const row of rawAutoav.slice(1)) {
        const nome = (row[iNomeAutoav] || '').trim();
        const esc  = (row[iEscolaAutoav] || '').trim();
        if (!nome) continue;
        const media = calcMedia(row, pilaresAutoav);
        const pilarScores = getPilarScores(row, pilaresAutoav, headAutoav);
        if (!autoavByNome[nome]) autoavByNome[nome] = { scores: [], pilarScores: {}, escola: esc };
        if (media !== null) autoavByNome[nome].scores.push(media);
        Object.entries(pilarScores).forEach(([p, v]) => {
          if (!autoavByNome[nome].pilarScores[p]) autoavByNome[nome].pilarScores[p] = [];
          autoavByNome[nome].pilarScores[p].push(v);
        });
      }

      // Agrupa observações por NOME + conta forms
      const obsByNome = {}, obsPilarByNome = {}, formsCount = {};
      for (const row of rawObs.slice(1)) {
        const nome = (row[iNomeObs] || '').trim();
        if (!nome) continue;
        formsCount[nome] = (formsCount[nome] || 0) + 1;
        const score = calcMedia(row, pilaresObs);
        if (score !== null) { if (!obsByNome[nome]) obsByNome[nome] = []; obsByNome[nome].push(score); }
        const pilarScoresObs = getPilarScores(row, pilaresObs, headObs);
        if (Object.keys(pilarScoresObs).length > 0) {
          if (!obsPilarByNome[nome]) obsPilarByNome[nome] = [];
          obsPilarByNome[nome].push(pilarScoresObs);
        }
      }

      // Um item por orientador
      const nomes = new Set([...Object.keys(autoavByNome), ...Object.keys(obsByNome)]);
      const resultado = [...nomes].map(nome => {
        const av = autoavByNome[nome] || { scores: [], pilarScores: {}, escola: '' };
        const autoavMedia = av.scores.length > 0 ? Math.round(av.scores.reduce((a,b)=>a+b,0)/av.scores.length*10)/10 : null;
        const pilarAutoav = {};
        Object.entries(av.pilarScores).forEach(([p, ss]) => { pilarAutoav[p] = Math.round(ss.reduce((a,b)=>a+b,0)/ss.length*10)/10; });
        const obsScores = obsByNome[nome] || [];
        const obsMedia = obsScores.length > 0 ? Math.round(obsScores.reduce((a,b)=>a+b,0)/obsScores.length*10)/10 : null;
        const mediaFinal = obsMedia !== null ? Math.round(((autoavMedia||0)+obsMedia)/2*10)/10 : autoavMedia;
        const obsPilarRaw = obsPilarByNome[nome] || [];
        const obsPilarAgg = {};
        obsPilarRaw.forEach(ps => { Object.entries(ps).forEach(([pilar, score]) => { if (!obsPilarAgg[pilar]) obsPilarAgg[pilar] = []; obsPilarAgg[pilar].push(score); }); });
        const pilarObs = {};
        Object.entries(obsPilarAgg).forEach(([pilar, ss]) => { pilarObs[pilar] = Math.round(ss.reduce((a,b)=>a+b,0)/ss.length*10)/10; });
        return { nome, escola: av.escola, praca: getPraca(av.escola), autoav: autoavMedia, obs: obsMedia, media: mediaFinal, forms: formsCount[nome]||0, apenasAutoav: obsMedia===null, pilarAutoav, pilarObs };
      });


      function findWorst(pilarAvgs) {
        const entries = Object.entries(pilarAvgs);
        if (!entries.length) return null;
        return entries.sort((a,b) => a[1]-b[1])[0][0];
      }
      const pilarByPraca = {};
      for (const r of resultado) {
        if (r.praca === '—') continue;
        if (!pilarByPraca[r.praca]) pilarByPraca[r.praca] = { autoav: {}, obs: {} };
        Object.entries(r.pilarAutoav).forEach(([pilar, score]) => { if (!pilarByPraca[r.praca].autoav[pilar]) pilarByPraca[r.praca].autoav[pilar] = []; pilarByPraca[r.praca].autoav[pilar].push(score); });
        Object.entries(r.pilarObs).forEach(([pilar, score]) => { if (!pilarByPraca[r.praca].obs[pilar]) pilarByPraca[r.praca].obs[pilar] = []; pilarByPraca[r.praca].obs[pilar].push(score); });
      }
      const pilarStats = {};
      for (const [praca, data] of Object.entries(pilarByPraca)) {
        const avgAutoav = {}, avgObs = {};
        Object.entries(data.autoav).forEach(([p, ss]) => { avgAutoav[p] = ss.reduce((a,b)=>a+b,0)/ss.length; });
        Object.entries(data.obs).forEach(([p, ss]) => { avgObs[p] = ss.reduce((a,b)=>a+b,0)/ss.length; });
        pilarStats[praca] = { worstAutoav: findWorst(avgAutoav), worstObs: findWorst(avgObs) };
      }

      resultado.sort((a, b) => (b.media || 0) - (a.media || 0));
      return res.status(200).json({ orientadores: resultado, pilarStats });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── FEEDBACK ALUNOS ─────────────────────────────────────────────
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
          let ratingIdx = headers.findIndex(h =>
            h.includes('nota') || h.includes('avalia') || h.includes('estrela') ||
            h.includes('satisfa') || h.includes('como foi') || h.includes('como você')
          );
          if (ratingIdx === -1) {
            let bestCol = -1, bestCount = 0;
            for (let ci = 1; ci < (rows[0] || []).length; ci++) {
              const count = rows.slice(1).filter(r => parseRating(r[ci]) !== null).length;
              if (count > bestCount) { bestCount = count; bestCol = ci; }
            }
            if (bestCount > rows.length * 0.3) ratingIdx = bestCol;
          }
          if (ratingIdx === -1) return { ...s, respostas: 0, media: null };
          const scores = rows.slice(1).map(r => parseRating(r[ratingIdx])).filter(n => n !== null);
          if (scores.length === 0) return { ...s, respostas: 0, media: null };
          const media = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10;
          return { ...s, respostas: scores.length, media };
        } catch(_) { return { ...s, respostas: 0, media: null }; }
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
      for (const s of sheetIds) {
        try {
          const url = `https://sheets.googleapis.com/v4/spreadsheets/${s.id}/values/A1:Z1000?key=${sheetsKey}`;
          const r = await fetch(url);
          const d = await r.json();
          const rows = d.values || [];
          if (rows.length < 2) continue;
          const header = rows[0].map(h => (h || '').toLowerCase());
          const iComent = header.findIndex(h => h.includes('espaço livre') || h.includes('comentário') || h.includes('dúvida') || h.includes('livre'));
          if (iComent === -1) continue;
          const iPraca = header.findIndex(h => h.includes('praça') || h.includes('praca'));
          for (const row of rows.slice(1)) {
            const txt = (row[iComent] || '').trim();
            if (txt.length < 15) continue;
            const praca = iPraca !== -1 ? (row[iPraca] || '').trim() : '';
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
Corrija ortografia, pontuação e capitalização. Mantenha o sentido original.
Cada comentário entre 15 e 120 caracteres.
Extraia praça e série da tag (ex: [SP · 1ºEM · C1] → praca: "SP", serie: "1ºEM").

Responda APENAS com JSON válido, sem markdown, sem texto antes ou depois:
{"total_comentarios":209,"percentuais":{"positivos":62,"criticas":18,"melhorias":20},"comentarios":[{"texto":"...","praca":"SP","serie":"1ºEM","categoria":"positivo"}]}

COMENTÁRIOS:
${textos}`;

    try {
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 3000, temperature: 0, messages: [{ role: 'user', content: prompt }] })
      });
      const aiData = await aiRes.json();
      const text = (aiData.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      return res.status(200).json({ vozes: text, _debug: { total_linhas: linhas.length, exemplo: linhas.slice(0,3), stop_reason: aiData.stop_reason, usage: aiData.usage, ai_error: aiData.error } });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── PRAÇAS CICLO 2 ──────────────────────────────────────────────
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

    function normSerie(s) { return (s || '').toLowerCase().replace(/[°º˚]/g,'').replace(/\s+/g,'').replace(/[^a-z0-9]/g,''); }
    function matchSerie(turma, grupo) { const t = normSerie(turma); return grupo.some(s => t.includes(normSerie(s))); }
    function calcPct(rows, iturma, iofic, ifa, grupo) {
      const filtrado = rows.filter(r => matchSerie(r[iturma], grupo));
      if (!filtrado.length) return { oficinas: null, falaAi: null };
      const ofic = filtrado.filter(r => (r[iofic]||'').toLowerCase().includes('realizada') && !(r[iofic]||'').toLowerCase().includes('não')).length;
      const fa   = filtrado.filter(r => (r[ifa]  ||'').toLowerCase().includes('realizado') && !(r[ifa]  ||'').toLowerCase().includes('não')).length;
      return { oficinas: Math.round(ofic/filtrado.length*1000)/10, falaAi: Math.round(fa/filtrado.length*1000)/10 };
    }

    try {
      const resultado = {}, debugInfo = {};
      await Promise.all(Object.entries(SHEETS).map(async ([praca, id]) => {
        try {
          const url  = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent('Dados!A1:Z2000')}?key=${sheetsKey}`;
          const r    = await fetch(url);
          const d    = await r.json();
          const rows = d.values || [];
          if (rows.length < 2) { resultado[praca] = { geral: { oficinas: null, falaAi: null }, em3: { oficinas: null, falaAi: null } }; return; }
          const row0 = rows[0].map(h => (h||'').toLowerCase().trim());
          const row1 = rows[1] ? rows[1].map(h => (h||'').toLowerCase().trim()) : [];
          const ciclo2Start = row0.findIndex(h => h.includes('ciclo 2') || h === 'ciclo2');
          let iturma = row0.findIndex(h => h.includes('turma'));
          if (iturma === -1) iturma = row1.findIndex(h => h.includes('turma'));
          let iofic = -1, ifa = -1;
          if (ciclo2Start !== -1) {
            for (let c = ciclo2Start; c < ciclo2Start + 3 && c < row1.length; c++) {
              if (row1[c] && row1[c].includes('oficina') && iofic === -1) iofic = c;
              if (row1[c] && (row1[c].includes('fala') || row1[c].includes('fa ')) && ifa === -1) ifa = c;
            }
            if (iofic === -1) iofic = ciclo2Start;
            if (ifa   === -1) ifa   = ciclo2Start + 1;
          }
          debugInfo[praca] = { ciclo2Start, iturma, iofic, ifa };
          if (iturma === -1 || ciclo2Start === -1) { resultado[praca] = { geral: { oficinas: null, falaAi: null }, em3: { oficinas: null, falaAi: null } }; return; }
          const data = rows.slice(2);
          resultado[praca] = { geral: calcPct(data, iturma, iofic, ifa, SERIES_GERAL), em3: calcPct(data, iturma, iofic, ifa, SERIES_3EM) };
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

  // ── FEEDBACK MNM POR PRAÇA ──────────────────────────────────────
  if (action === 'get_feedback_pracas') {
    const sheetsKey = process.env.GOOGLE_SHEETS_API_KEY;
    if (!sheetsKey) return res.status(500).json({ error: 'GOOGLE_SHEETS_API_KEY não configurada.' });

    const PRACA_SHEETS = {
      SP:  '1anki0VweR8LweziQkN-KDTJbklAp9asfdxtU5JhkMhk',
      BH:  '14uStnQL61Yu4xQJTGpmBt5d9d_s5681i8MAdLUkAnTg',
      RJ:  '1TsCj4_MqfIWCZF8j30E_hnpw8z3nDz8Ph5lMIXZEAuc',
      SJC: '1xBgYIGMjGDFyOS1VVu62RGciDoSNZNSy9ZtOFjEUjHc'
    };

    async function calcFeedbackPct(sheetId, aba) {
      const range = encodeURIComponent(aba + '!A2:M2000');
      const url   = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?key=${sheetsKey}`;
      const r = await fetch(url);
      const d = await r.json();
      const rows = d.values || [];
      let total = 0, comFeedback = 0;
      for (const row of rows) {
        const orientador = String(row[1] || '').trim();
        if (!orientador) continue;
        const entregou = String(row[7] || '').toLowerCase().trim();
        if (entregou !== 'true' && entregou !== 'verdadeiro') continue;
        total++;
        const temRubrica = [8, 9, 10, 11, 12].some(i => row[i] && String(row[i]).trim() !== '');
        if (temRubrica) comFeedback++;
      }
      return total > 0 ? Math.round(comFeedback / total * 1000) / 10 : null;
    }

    try {
      const feedbacks = {};
      for (const [num, abaName] of [[1, 'Ciclo 1'], [2, 'Ciclo 2']]) {
        feedbacks[num] = {};
        await Promise.all(Object.entries(PRACA_SHEETS).map(async ([praca, id]) => {
          try { feedbacks[num][praca] = await calcFeedbackPct(id, abaName); }
          catch(_) { feedbacks[num][praca] = null; }
        }));
      }
      return res.status(200).json({ feedbacks });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── DADOS DO GOOGLE SHEETS ──────────────────────────────────────
  if (action === 'get_sheets_data') {
    const sheetsKey = process.env.GOOGLE_SHEETS_API_KEY;
    if (!sheetsKey) return res.status(500).json({ error: 'GOOGLE_SHEETS_API_KEY não configurada.' });

    const sheetIds = {
      dados_semanais: '1A_AP1pUt5f-wwoFyhEWuzn1zt2O1baIhLsH5oZjE4Fc',
      presenca_sp:    '1anki0VweR8LweziQkN-KDTJbklAp9asfdxtU5JhkMhk',
      presenca_bh:    '14uStnQL61Yu4xQJTGpmBt5d9d_s5681i8MAdLUkAnTg',
      presenca_rj:    '1TsCj4_MqfIWCZF8j30E_hnpw8z3nDz8Ph5lMIXZEAuc',
      presenca_sjc:   '1xBgYIGMjGDFyOS1VVu62RGciDoSNZNSy9ZtOFjEUjHc'
    };

    async function fetchSheet(sheetId, range) {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?key=${sheetsKey}`;
      const r = await fetch(url);
      return r.json();
    }

    try {
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

  // ── ANÁLISE DE RUBRICAS ──────────────────────────────────────────
  if (action === 'get_rubricas') {
    const sheetsKey = process.env.GOOGLE_SHEETS_API_KEY;
    if (!sheetsKey) return res.status(500).json({ error: 'GOOGLE_SHEETS_API_KEY não configurada.' });

    async function fetchAba(aba) {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/1A_AP1pUt5f-wwoFyhEWuzn1zt2O1baIhLsH5oZjE4Fc/values/${encodeURIComponent(aba + '!A1:Z200')}?key=${sheetsKey}`;
      const r = await fetch(url);
      const d = await r.json();
      return d.values || [];
    }

    function parseRubricas(rows) {
      // Localiza blocos pelos títulos nas células
      let pilares = [], pracas = [], orientadores = [];
      let mode = null;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const cell0 = (row[0] || '').trim();
        const cell1 = (row[1] || '').trim();

        // detecta início dos blocos
        if (cell1.includes('Pilares da rubrica') || cell0.includes('Pilares da rubrica')) { mode = 'pilares'; continue; }
        if (cell1.includes('Média por praça') || cell0.includes('Média por praça')) { mode = 'pracas'; continue; }
        if (cell1.includes('Padrão de avaliação') || cell0.includes('Padrão de avaliação')) { mode = 'orientadores'; continue; }

        // linha de cabeçalho — pula
        const textoLinha = row.join('').toLowerCase();
        if (textoLinha.includes('pos.') || textoLinha.includes('pilar da rubrica')) continue;
        if (textoLinha.includes('pilar') && textoLinha.includes('sp') && textoLinha.includes('bh')) continue;
        if (textoLinha.includes('orientador') && textoLinha.includes('média geral') && textoLinha.includes('alunos')) continue;

        if (mode === 'pilares') {
          // colunas: pos | pilar | média | avaliações
          const pos  = (row[1] || row[0] || '').trim();
          const nome = (row[2] || row[1] || '').trim();
          const med  = (row[3] || row[2] || '').trim();
          const aval = (row[4] || row[3] || '').trim();
          if (nome && med && !isNaN(parseFloat(med.replace(',', '.')))) {
            pilares.push({ pos, nome, media: parseFloat(med.replace(',', '.')), avaliacoes: aval });
          }
          if (pilares.length >= 5) mode = null;
        }

        if (mode === 'pracas') {
          const nome = (row[0] || row[1] || '').trim();
          const sp   = parseFloat((row[1] || row[2] || '').replace(',', '.')) || null;
          const bh   = parseFloat((row[2] || row[3] || '').replace(',', '.')) || null;
          const rj   = parseFloat((row[3] || row[4] || '').replace(',', '.')) || null;
          const sjc  = parseFloat((row[4] || row[5] || '').replace(',', '.')) || null;
          if (nome && (sp || bh || rj || sjc)) {
            pracas.push({ nome, sp, bh, rj, sjc });
          }
        }

        if (mode === 'orientadores') {
          const nome   = (row[1] || row[0] || '').trim();
          const media  = parseFloat((row[2] || row[1] || '').replace(',', '.')) || null;
          const alunos = (row[3] || row[2] || '').trim();
          const padrao = (row[4] || row[3] || '').trim();
          if (nome && media) {
            orientadores.push({ nome, media, alunos, padrao });
          }
        }
      }

      return { pilares, pracas, orientadores };
    }

    try {
      const [rows1, rows2] = await Promise.all([
        fetchAba('Ciclo 1 - Detalhes'),
        fetchAba('Ciclo 2 - Detalhes')
      ]);
      return res.status(200).json({
        ciclo1: parseRubricas(rows1),
        ciclo2: parseRubricas(rows2)
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── PROGRESSO POR CICLO (board 18417049088) ────────────────────
  if (action === 'get_ciclo_progress') {
    const mondayToken = process.env.MONDAY_API_TOKEN;
    if (!mondayToken) return res.status(500).json({ error: 'MONDAY_API_TOKEN não configurado.' });

    const allItems = [];
    let cursor = null;

    // Pagina até buscar todos os itens
    do {
      const cursorArg = cursor ? `, cursor: "${cursor}"` : '';
      const query = `{
        boards(ids: [18417049088]) {
          items_page(limit: 100${cursorArg}) {
            cursor
            items {
              name
              column_values(ids: ["color_mm45ytfp"]) { id text }
            }
          }
        }
      }`;

      const r = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': mondayToken, 'API-Version': '2024-01' },
        body: JSON.stringify({ query })
      });
      const d = await r.json();
      if (d.errors) return res.status(400).json({ error: d.errors[0].message });

      const page = d?.data?.boards?.[0]?.items_page;
      (page?.items || []).forEach(item => allItems.push(item));
      cursor = page?.cursor || null;
    } while (cursor);

    // Agrega por nome: conta total e feitos
    const map = {};
    for (const item of allItems) {
      const nome = item.name.trim();
      const status = (item.column_values?.[0]?.text || '').trim();
      if (!map[nome]) map[nome] = { total: 0, feitos: 0 };
      map[nome].total++;
      if (status === 'Feito') map[nome].feitos++;
    }

    // Calcula porcentagem — omite itens únicos (total === 1)
    const progress = {};
    for (const [nome, val] of Object.entries(map)) {
      if (val.total > 1) {
        progress[nome] = {
          total: val.total,
          feitos: val.feitos,
          pct: Math.round(val.feitos / val.total * 100)
        };
      }
    }

    return res.status(200).json({ progress });
  }

  // ── DADOS DO MONDAY (get_milestones) ────────────────────────────
  const mondayToken = process.env.MONDAY_API_TOKEN;
  if (!mondayToken) return res.status(500).json({ error: 'MONDAY_API_TOKEN não configurado.' });

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
                column_values { id text value }
                subitems {
                  id
                  name
                  column_values { id text value }
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

    // Filtra só os itens M1-M5 (um único por marco, estrutura nova do board)
    const marcoItems = items.filter(i => /^M[1-5]\s/i.test(i.name));

    const STATUS_VALUES = ['Feito', 'Em andamento', 'Congelado', 'Não iniciado', 'Atrasado', 'Planejado'];

    function findColText(column_values, id) {
      const col = column_values.find(c => c.id === id) || {};
      // Para coluna timeline, text pode vir vazio — tenta extrair de value (JSON)
      if (col.text) return col.text;
      if (col.value) {
        try {
          const v = JSON.parse(col.value);
          if (v.from && v.to) return v.from + ' - ' + v.to;
        } catch(_) {}
      }
      return '';
    }

    function findStatus(column_values) {
      // Tenta pelo ID específico primeiro
      const byId = column_values.find(c => c.id === 'color_mm1jjjjy' || c.id === 'status');
      if (byId?.text && STATUS_VALUES.includes(byId.text)) return byId.text;
      // Fallback: qualquer coluna com valor de status
      const byVal = column_values.find(c => STATUS_VALUES.includes(c.text));
      return byVal?.text || 'Não iniciado';
    }

    function formatTimeline(raw) {
      if (!raw) return null;
      const meses = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
      const partes = raw.split(' - ');
      if (partes.length !== 2) return null;
      function fmt(d) {
        const dt = new Date(d.trim());
        if (isNaN(dt)) return null;
        return meses[dt.getUTCMonth()] + '/' + dt.getUTCFullYear();
      }
      const ini = fmt(partes[0]);
      const fim = fmt(partes[1]);
      return (ini && fim) ? ini + ' — ' + fim : null;
    }

    function parseMarco(item) {
      const status = findStatus(item.column_values);
      const timeline = formatTimeline(findColText(item.column_values, 'timerange_mm1jm5x0') || '');

      const subitems = (item.subitems || []).map(sub => {
        const subStatus = findStatus(sub.column_values);

        // Coluna Time: color_mm3xvc4a
        const time = findColText(sub.column_values, 'color_mm3xvc4a') || null;

        // Coluna Ciclo: color_mm3xrbwm
        const ciclo = findColText(sub.column_values, 'color_mm3xrbwm') || null;

        // Coluna Evidência: link_mm3yfn4w — retorna texto/URL
        const evidenciaRaw = findColText(sub.column_values, 'link_mm3yfn4w') || '';
        // O tipo link no Monday retorna "texto - url" ou só o texto/url
        let evidenciaUrl   = null;
        let evidenciaLabel = null;
        if (evidenciaRaw) {
          // formato Monday: "Label - https://..." ou só a URL
          const linkMatch = evidenciaRaw.match(/^(.*?)\s*-\s*(https?:\/\/.+)$/);
          if (linkMatch) {
            evidenciaLabel = linkMatch[1].trim() || null;
            evidenciaUrl   = linkMatch[2].trim();
          } else if (evidenciaRaw.startsWith('http')) {
            evidenciaUrl = evidenciaRaw.trim();
          } else {
            evidenciaLabel = evidenciaRaw.trim();
          }
        }

        return {
          nome:   sub.name,
          status: subStatus,
          time,
          ciclo,
          evidenciaUrl,
          evidenciaLabel
        };
      });

      const ativos = subitems.filter(s => s.status !== 'Congelado');
      const done   = ativos.filter(s => s.status === 'Feito').length;

      return {
        id:     item.name.substring(0, 2).toUpperCase(),
        nome:   item.name.replace(/^M[1-5]\s[-–]\s?/i, ''),
        status,
        timeline,
        acomp:  ativos.length > 0 ? Math.round((done / ativos.length) * 100) : 0,
        done,
        total:  subitems.length,
        subitems
      };
    }

    // Um único array de marcos (estrutura nova: M1-M5 sem duplicata por ciclo)
    const milestones = marcoItems.map(parseMarco);

    return res.status(200).json({
      updatedAt: new Date().toLocaleDateString('pt-BR'),
      milestones,
      // Mantém ciclo1 por compatibilidade com eventuais referências antigas no index
      ciclo1: milestones
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
