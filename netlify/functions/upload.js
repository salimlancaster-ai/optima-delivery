const { google } = require('googleapis');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { filename, unit, imageData } = JSON.parse(event.body);

    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_KEY);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });

    const drive = google.drive({ version: 'v3', auth });

    const rootFolderId = await getOrCreateFolder(drive, 'Optima Signature Deliveries');
    const month = new Date().toISOString().slice(0, 7);
    const monthFolderId = await getOrCreateFolder(drive, month, rootFolderId);
    const unitFolderId = await getOrCreateFolder(drive, `Unit ${unit}`, monthFolderId);

    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const { Readable } = require('stream');
    const stream = Readable.from(buffer);

    const uploaded = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [unitFolderId],
      },
      media: {
        mimeType: 'image/jpeg',
        body: stream,
      },
      fields: 'id,name',
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, fileId: uploaded.data.id, filename }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};

async function getOrCreateFolder(drive, name, parentId = null) {
  let q = `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;

  const res = await drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive' });
  if (res.data.files.length > 0) return res.data.files[0].id;

  const meta = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    ...(parentId && { parents: [parentId] }),
  };
  const folder = await drive.files.create({ requestBody: meta, fields: 'id' });
  return folder.data.id;
}
