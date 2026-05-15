export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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

    // Filtra apenas M1-M5
    const marcoItems = items.filter(i => /^M[1-5]\s/i.test(i.name));

    // Agrupa por ID do marco (M1..M5), mantendo a ordem de aparição
    // Primeiro conjunto = Ciclo 1, segundo = Ciclo 2
    const grouped = {};
    for (const item of marcoItems) {
      const key = item.name.substring(0, 2).toUpperCase(); // "M1"..."M5"
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(item);
    }

    function parseMarco(item) {
      const statusCol = item.column_values.find(c => c.id === 'color_mm1jjjjy');
      const status = statusCol?.text || 'Não iniciado';

      const subitems = (item.subitems || []).map(sub => {
        const subStatus = sub.column_values.find(c => c.id === 'status');
        return { nome: sub.name, status: subStatus?.text || 'Não iniciado' };
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

    const ciclo1 = ['M1','M2','M3','M4','M5']
      .filter(k => grouped[k]?.[0])
      .map(k => parseMarco(grouped[k][0]));

    const ciclo2 = ['M1','M2','M3','M4','M5']
      .filter(k => grouped[k]?.[1])
      .map(k => parseMarco(grouped[k][1]));

    return res.status(200).json({
      updatedAt: new Date().toLocaleDateString('pt-BR'),
      ciclo1,
      ciclo2
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
