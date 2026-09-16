const { google } = require('googleapis');
const sgMail = require('@sendgrid/mail');

const ROOT_FOLDER_ID  = '1UOHnLXymieQLCPd9KqNsjNwjyZHA99xU';
const SHEET_ID        = '1wtmUPwkRexC4hraveWVtC1me9RKIs1-NeAzHx3yMS2s';
const CLIENT_ID       = '450769207094-j35fdsvrv947qjtfndpcmrvfk1qbtse2.apps.googleusercontent.com';
const SG_TEMPLATE_ID  = 'd-2fce9a145aa04f2aa2996627000d9d8f';

let cachedToken = null;
let tokenExpiry = null;
const pendingEmails = {};

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
    if (tokens.refresh_token) console.log('NEW REFRESH TOKEN:', tokens.refresh_token);
  });
  const { credentials } = await oauth2Client.refreshAccessToken();
  cachedToken = credentials.access_token;
  tokenExpiry = credentials.expiry_date || (Date.now() + 55*60*1000);
  oauth2Client.setCredentials(credentials);
  return oauth2Client;
}

async function getResidentEmails(auth, unit) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1!A:E',
  });
  const rows = res.data.values || [];
  return rows
    .slice(1)
    .filter(row =>
      row[0] && row[0].toString().trim() === unit.toString().trim() &&
      row[4] && row[4].toString().trim().toLowerCase() === 'yes'
    )
    .map(row => ({ name: row[2] || 'Resident', email: row[3] }))
    .filter(r => r.email && r.email.includes('@'));
}

async function sendConfirmationEmail(recipients, unit, filename, photoUrl) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  const now = new Date();
  const deliveryDate = now.toLocaleDateString('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric'
  });
  const deliveryTime = now.toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit'
  });

  for (const recipient of recipients) {
    await sgMail.send({
      to:         recipient.email,
      from:       { email: 'optimasignature.delivery@gmail.com', name: 'Optima Signature Deliveries' },
      subject:    `Package Delivered — Unit ${unit}`,
      templateId: SG_TEMPLATE_ID,
      dynamicTemplateData: {
        resident_name:     recipient.name,
        unit_number:       unit,
        delivery_date:     deliveryDate,
        delivery_time:     deliveryTime,
        filename:          filename,
        photo_url:         photoUrl,
        management_phone:  '(312) 555-0100',
        management_email:  'management@optimasignature.com',
        unsubscribe_url:   '#',
        privacy_url:       '#',
      },
    });
    console.log('Email sent to:', recipient.email);
  }
}

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  try {
    const body = JSON.parse(event.body);
    const { filename, unit, imageData, action, deliveryId } = body;

    // Cancel pending email
    if (action === 'cancel' && deliveryId) {
      if (pendingEmails[deliveryId]) {
        clearTimeout(pendingEmails[deliveryId]);
        delete pendingEmails[deliveryId];
        console.log('Email cancelled for:', deliveryId);
      }
      return { statusCode: 200, body: JSON.stringify({ success: true, cancelled: true }) };
    }

    const auth  = await getAuthClient();
    const drive = google.drive({ version: 'v3', auth });

    const now   = new Date();
    const month = now.toISOString().slice(0, 7);
    const date  = now.toISOString().slice(0, 10);

    const monthFolderId = await getOrCreateFolder(drive, month, ROOT_FOLDER_ID);
    const dateFolderId  = await getOrCreateFolder(drive, date, monthFolderId);
    const unitFolderId  = await getOrCreateFolder(drive, `Unit ${unit}`, dateFolderId);

    // Duplicate prevention
    const existingCheck = await drive.files.list({
      q: `name='${filename}' and '${unitFolderId}' in parents and trashed=false`,
      fields: 'files(id,name)',
    });
    if (existingCheck.data.files.length > 0) {
      const existingId = existingCheck.data.files[0].id;
      console.log('Duplicate prevented:', filename);
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true, fileId: existingId, filename, duplicate: true,
          photoUrl: `https://drive.google.com/uc?export=view&id=${existingId}`,
        }),
      };
    }

    // Upload photo
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const buffer     = Buffer.from(base64Data, 'base64');
    const { Readable } = require('stream');

    const uploaded = await drive.files.create({
      requestBody: { name: filename, parents: [unitFolderId] },
      media: { mimeType: 'image/jpeg', body: Readable.from(buffer) },
      fields: 'id,name',
    });

    // Share file publicly so it can be embedded in email
    try {
      await drive.permissions.create({
        fileId: uploaded.data.id,
        requestBody: { role: 'reader', type: 'anyone' },
        supportsAllDrives: true,
      });
      console.log('File shared publicly');
    } catch(permErr) {
      console.log('Permission warning (non-fatal):', permErr.message);
    }
    const photoUrl = `https://drive.google.com/uc?export=view&id=${uploaded.data.id}`;
    console.log('SUCCESS:', uploaded.data.name);

    // Look up residents from Sheet
    const recipients = await getResidentEmails(auth, unit);
    console.log('Recipients for unit', unit, ':', recipients.length, JSON.stringify(recipients.map(r=>r.email)));

    // Send confirmation email immediately
    if (recipients.length > 0) {
      try {
        await sendConfirmationEmail(recipients, unit, filename, photoUrl);
        console.log('Email sent successfully for unit:', unit);
      } catch(e) {
        console.log('Email error (non-fatal):', e.message);
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        fileId: uploaded.data.id,
        filename: uploaded.data.name,
        photoUrl,
        emailScheduled: recipients.length > 0,
        recipientCount: recipients.length,
      }),
    };

  } catch (err) {
    console.log('ERROR:', err.message);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
