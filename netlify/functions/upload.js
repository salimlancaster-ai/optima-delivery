const { google } = require('googleapis');

const ROOT_FOLDER_ID  = '1UOHnLXymieQLCPd9KqNsjNwjyZHA99xU';
const CLIENT_ID       = '450769207094-j35fdsvrv947qjtfndpcmrvfk1qbtse2.apps.googleusercontent.com';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { filename, unit, imageData } = JSON.parse(event.body);

    // Use OAuth2 with refresh token — uploads as the Gmail account owner
    const oauth2Client = new google.auth.OAuth2(
      CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'http://localhost:3000'
    );

    oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    // Build folder structure inside shared Gmail Drive folder
    const month        = new Date().toISOString().slice(0, 7);
    const monthFolderId = await getOrCreateFolder(drive, month, ROOT_FOLDER_ID);
    const unitFolderId  = await getOrCreateFolder(drive, `Unit ${unit}`, monthFolderId);

    // Upload the photo
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const buffer     = Buffer.from(base64Data, 'base64');
    const { Readable } = require('stream');
    const stream     = Readable.from(buffer);

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

    console.log('SUCCESS:', uploaded.data.name, '| ID:', uploaded.data.id);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        fileId: uploaded.data.id,
        filename: uploaded.data.name,
      }),
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

  if (res.data.files.length > 0) {
    console.log('Found folder:', name, res.data.files[0].id);
    return res.data.files[0].id;
  }

  const folder = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });

  console.log('Created folder:', name, folder.data.id);
  return folder.data.id;
}
