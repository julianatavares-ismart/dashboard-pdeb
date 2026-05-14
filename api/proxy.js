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
            name
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

    const mondayData = await mondayRes.json();

    if (mondayData.errors) {
      return res.status(400).json({ error: mondayData.errors[0].message });
    }

    const items = mondayData?.data?.boards?.[0]?.items_page?.items || [];

    const milestones = items
      .filter(item => /^M[1-5]\s/i.test(item.name))
      .map(item => {
        const statusCol = item.column_values.find(c => c.id === 'status' || c.id === 'color');
        const status = statusCol?.text || 'Não iniciado';

        const subitems = (item.subitems || []).map(sub => {
          const subStatus = sub.column_values.find(c => c.id === 'status' || c.id === 'color');
          return { nome: sub.name, status: subStatus?.text || 'Não iniciado' };
        });

        const done  = subitems.filter(s => ['Feito','Done','Concluído'].includes(s.status)).length;
        const total = subitems.length || 1;
        const acomp = Math.round((done / total) * 100);

        return {
          id: item.name.substring(0, 2).toUpperCase(),
          nome: item.name.replace(/^M[1-5]\s[-–]\s?/i, ''),
          status,
          acomp,
          done,
          total,
          subitems
        };
      });

    return res.status(200).json({
      source: 'monday',
      updatedAt: new Date().toLocaleDateString('pt-BR'),
      milestones
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
