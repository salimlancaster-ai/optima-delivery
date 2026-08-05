const { google } = require('googleapis');

const ROOT_FOLDER_ID = '1UOHnLXymieQLCPd9KqNsjNwjyZHA99xU';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { filename, unit, imageData } = JSON.parse(event.body);

    // Service account auth — never expires, no token refresh needed
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_KEY);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

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
