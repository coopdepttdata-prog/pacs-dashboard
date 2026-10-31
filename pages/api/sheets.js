import { fetchSheetData } from '../../lib/sheets';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { tab } = req.query;
  if (!tab) {
    return res.status(400).json({ error: 'tab query parameter is required' });
  }

  try {
    const data = await fetchSheetData(tab);
    // Cache for 60 seconds; serve stale for up to 2 minutes while revalidating
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}