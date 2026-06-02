const { google } = require('googleapis');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const body = JSON.parse(event.body);
    console.log('STEP 1: Body parsed, unit:', body.unit, 'filename:', body.filename);

    const rawKey = process.env.GOOGLE_SERVICE_KEY;
    console.log('STEP 2: Key exists:', !!rawKey, 'Key length:', rawKey ? rawKey.length : 0);

    const credentials = JSON.parse(rawKey);
    console.log('STEP 3: Credentials parsed, client_email:', credentials.client_email);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    console.log('STEP 4: Auth created');

    const drive = google.drive({ version: 'v3', auth });
    console.log('STEP 5: Drive client created');

    const rootFolderId = await getOrCreateFolder(drive, 'Optima Signature Deliveries');
    console.log('STEP 6: Root folder ID:', rootFolderId);

    const month = new Date().toISOString().slice(0, 7);
    const monthFolderId = await getOrCreateFolder(drive, month, rootFolderId);
    console.log('STEP 7: Month folder ID:', monthFolderId);

    const unitFolderId = await getOrCreateFolder(drive, `Unit ${body.unit}`, monthFolderId);
    console.log('STEP 8: Unit folder ID:', unitFolderId);

    const base64Data = body.imageData.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const { Readable } = require('stream');
    const stream = Readable.from(buffer);

    const uploaded = await drive.files.create({
      requestBody: {
        name: body.filename,
        parents: [unitFolderId],
      },
      media: {
        mimeType: 'image/jpeg',
        body: stream,
      },
      fields: 'id,name',
    });
    console.log('STEP 9: File uploaded, ID:', uploaded.data.id);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, fileId: uploaded.data.id, filename: body.filename }),
    };

  } catch (err) {
    console.log('FULL ERROR:', err.message);
    console.log('ERROR STACK:', err.stack);
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
