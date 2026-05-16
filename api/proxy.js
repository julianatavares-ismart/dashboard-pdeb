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
