const { google } = require('googleapis');

const ROOT_FOLDER_ID = '1UOHnLXymieQLCPd9KqNsjNwjyZHA99xU';
const SHEET_ID       = '1wtmUPwkRexC4hraveWVtC1me9RKIs1-NeAzHx3yMS2s';
const CLIENT_ID      = '450769207094-j35fdsvrv947qjtfndpcmrvfk1qbtse2.apps.googleusercontent.com';

let cachedToken = null;
let tokenExpiry = null;

async function getAuthClient() {
  const oauth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost:3000'
  );
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry - 60000) {
    oauth2Client.setCredentials({ access_token: cachedToken, refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    return oauth2Client;
  }
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  oauth2Client.on('tokens', (tokens) => {
    if (tokens.access_token) { cachedToken = tokens.access_token; tokenExpiry = tokens.expiry_date || (Date.now() + 55*60*1000); }
  });
  const { credentials } = await oauth2Client.refreshAccessToken();
  cachedToken = credentials.access_token;
  tokenExpiry = credentials.expiry_date || (Date.now() + 55*60*1000);
  oauth2Client.setCredentials(credentials);
  return oauth2Client;
}

exports.handler = async (event) => {
  try {
    const auth  = await getAuthClient();
    const drive = google.drive({ version: 'v3', auth });

    // Read date from query param or default to today
    const params = new URLSearchParams(event.queryStringParameters || {});
    const today = params.get('date') || new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);

    // Find month folder
    const monthRes = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and name='${month}' and '${ROOT_FOLDER_ID}' in parents and trashed=false`,
      fields: 'files(id,name)',
    });
    if (!monthRes.data.files.length) {
      return { statusCode: 200, body: JSON.stringify({ deliveries: [] }) };
    }
    const monthId = monthRes.data.files[0].id;

    // Find today folder
    const dateRes = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and name='${today}' and '${monthId}' in parents and trashed=false`,
      fields: 'files(id,name)',
    });
    if (!dateRes.data.files.length) {
      return { statusCode: 200, body: JSON.stringify({ deliveries: [] }) };
    }
    const dateId = dateRes.data.files[0].id;

    // Get all unit folders under today
    const unitRes = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and '${dateId}' in parents and trashed=false`,
      fields: 'files(id,name)',
      orderBy: 'name',
    });

    // Load resident sheet for name lookup
    const sheets = google.sheets({ version: 'v4', auth });
    const sheetRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:E',
    });
    const rows = sheetRes.data.values || [];
    const residentMap = {};
    rows.slice(1).forEach(row => {
      if (row[0] && row[2]) residentMap[row[0].trim()] = row[2];
    });

    // Get photos from each unit folder
    const deliveries = [];
    for (const unitFolder of unitRes.data.files) {
      const unit = unitFolder.name.replace('Unit ', '');
      const filesRes = await drive.files.list({
        q: `'${unitFolder.id}' in parents and mimeType='image/jpeg' and trashed=false`,
        fields: 'files(id,name,createdTime)',
        orderBy: 'createdTime desc',
      });
      for (const file of filesRes.data.files) {
        // Parse time from filename U301_2026-06-01_14-32.jpg
        const parts = file.name.split('_');
        const timeStr = parts.length >= 3 ? parts[2].replace('.jpg','').replace('-',':') : '—';
        deliveries.push({
          unit,
          filename: file.name,
          fileId: file.id,
          photoUrl: `https://drive.google.com/thumbnail?id=${file.id}&sz=w800`,
          time: timeStr,
          name: residentMap[unit] || null,
        });
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deliveries, date: today, count: deliveries.length }),
    };

  } catch(err) {
    console.log('ERROR:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message, deliveries: [] }) };
  }
};
