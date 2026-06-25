const { google } = require('googleapis');

const ROOT_FOLDER_ID = '1UOHnLXymieQLCPd9KqNsjNwjyZHA99xU';
const CLIENT_ID      = '450769207094-j35fdsvrv947qjtfndpcmrvfk1qbtse2.apps.googleusercontent.com';

// Cache the access token in memory for the lifetime of the function instance
// This avoids hitting the token endpoint on every single upload
let cachedAccessToken = null;
let tokenExpiry = null;

async function getAuthClient() {
  const oauth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost:3000'
  );

  // If we have a valid cached token, use it
  if (cachedAccessToken && tokenExpiry && Date.now() < tokenExpiry - 60000) {
    oauth2Client.setCredentials({
      access_token: cachedAccessToken,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });
    return oauth2Client;
  }

  // Otherwise set refresh token and let Google auto-refresh
  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });

  // Listen for token refresh events and cache the new token
  oauth2Client.on('tokens', (tokens) => {
    if (tokens.access_token) {
      cachedAccessToken = tokens.access_token;
      // Cache for 55 minutes (tokens last 60 min, refresh 5 min early)
      tokenExpiry = Date.now() + 55 * 60 * 1000;
      console.log('Token refreshed and cached');
    }
    // If a new refresh token is issued, log it (rare but can happen)
    if (tokens.refresh_token) {
      console.log('NEW REFRESH TOKEN ISSUED:', tokens.refresh_token);
      console.log('Update GOOGLE_REFRESH_TOKEN in Netlify env vars with the above value');
    }
  });

  // Force a token refresh now to prime the cache
  try {
    const { credentials } = await oauth2Client.refreshAccessToken();
    cachedAccessToken = credentials.access_token;
    tokenExpiry = credentials.expiry_date || (Date.now() + 55 * 60 * 1000);
    oauth2Client.setCredentials(credentials);
  } catch(e) {
    console.log('Token refresh failed:', e.message);
    throw new Error('Authentication failed — refresh token may need updating');
  }

  return oauth2Client;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { filename, unit, imageData } = JSON.parse(event.body);

    const auth  = await getAuthClient();
    const drive = google.drive({ version: 'v3', auth });

    // Folder structure: Root / YYYY-MM / YYYY-MM-DD / Unit NNN
    const now   = new Date();
    const month = now.toISOString().slice(0, 7);
    const date  = now.toISOString().slice(0, 10);

    const monthFolderId = await getOrCreateFolder(drive, month, ROOT_FOLDER_ID);
    const dateFolderId  = await getOrCreateFolder(drive, date, monthFolderId);
    const unitFolderId  = await getOrCreateFolder(drive, `Unit ${unit}`, dateFolderId);

    // Upload photo
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const buffer     = Buffer.from(base64Data, 'base64');
    const { Readable } = require('stream');
    const stream     = Readable.from(buffer);

    const uploaded = await drive.files.create({
      requestBody: { name: filename, parents: [unitFolderId] },
      media: { mimeType: 'image/jpeg', body: stream },
      fields: 'id,name',
    });

    console.log('SUCCESS:', uploaded.data.name, '| ID:', uploaded.data.id);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, fileId: uploaded.data.id, filename: uploaded.data.name }),
    };

  } catch (err) {
    console.log('ERROR:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};

async function getOrCreateFolder(drive, name, parentId) {
  const q = `mimeType='application/vnd.google-apps.folder' and name='${name}' and '${parentId}' in parents and trashed=false`;
  const res = await drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive' });
  if (res.data.files.length > 0) return res.data.files[0].id;
  const folder = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
  });
  return folder.data.id;
}
