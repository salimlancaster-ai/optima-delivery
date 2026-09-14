const { google } = require('googleapis');
const sgMail = require('@sendgrid/mail');

const ROOT_FOLDER_ID = '1UOHnLXymieQLCPd9KqNsjNwjyZHA99xU';
const SHEET_ID       = '1wtmUPwkRexC4hraveWVtC1me9RKIs1-NeAzHx3yMS2s';
const CLIENT_ID      = '450769207094-j35fdsvrv947qjtfndpcmrvfk1qbtse2.apps.googleusercontent.com';

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
    .filter(row => row[0] && row[0].toString().trim() === unit.toString().trim() && row[4] && row[4].toString().trim().toLowerCase() === 'yes')
    .map(row => ({ name: row[2] || 'Resident', email: row[3] }))
    .filter(r => r.email && r.email.includes('@'));
}

async function sendConfirmationEmail(recipients, unit, filename, photoUrl) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  const now = new Date();
  const timeStr = now.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });

  for (const recipient of recipients) {
    const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
        <tr><td style="background:#1B2A4A;padding:28px 32px;text-align:center">
          <div style="font-family:Georgia,serif;font-size:22px;font-weight:bold;color:#C9A84C;letter-spacing:1px">OPTIMA SIGNATURE</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.6);margin-top:4px;letter-spacing:2px;text-transform:uppercase">Package Delivery Confirmation</div>
        </td></tr>
        <tr><td style="padding:32px">
          <p style="margin:0 0 8px;font-size:16px;color:#1B2A4A">Hello ${recipient.name},</p>
          <p style="margin:0 0 24px;font-size:14px;color:#555;line-height:1.6">Your package has been delivered to your unit. Please see the delivery photo below for confirmation.</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f8f6;border-radius:8px;margin-bottom:24px">
            <tr>
              <td style="padding:16px 20px;border-bottom:1px solid #eee">
                <span style="font-size:11px;font-weight:bold;color:#888;text-transform:uppercase;letter-spacing:1px">Unit</span><br>
                <span style="font-size:16px;font-weight:bold;color:#1B2A4A">${unit}</span>
              </td>
              <td style="padding:16px 20px;border-bottom:1px solid #eee">
                <span style="font-size:11px;font-weight:bold;color:#888;text-transform:uppercase;letter-spacing:1px">Delivered</span><br>
                <span style="font-size:14px;color:#333">${timeStr} CT</span>
              </td>
            </tr>
            <tr>
              <td colspan="2" style="padding:16px 20px">
                <span style="font-size:11px;font-weight:bold;color:#888;text-transform:uppercase;letter-spacing:1px">Reference</span><br>
                <span style="font-size:12px;color:#555;font-family:monospace">${filename}</span>
              </td>
            </tr>
          </table>
          <div style="text-align:center;margin-bottom:24px">
            <img src="${photoUrl}" alt="Delivery Photo" style="max-width:100%;border-radius:8px;border:1px solid #eee">
          </div>
          <p style="margin:0;font-size:13px;color:#888;line-height:1.6">If you have any questions about your delivery, please contact the concierge desk.</p>
        </td></tr>
        <tr><td style="background:#1B2A4A;padding:20px 32px;text-align:center">
          <div style="font-size:11px;color:rgba(255,255,255,0.5)">Optima Signature · Package Services · Chicago, IL</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    await sgMail.send({
      to: recipient.email,
      from: { email: 'optimasignature.delivery@gmail.com', name: 'Optima Signature Deliveries' },
      subject: `Package Delivered — Unit ${unit}`,
      html,
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

    // ── DUPLICATE PREVENTION ──────────────────────────────────────
    // Check if this exact filename already exists before uploading
    const existingCheck = await drive.files.list({
      q: `name='${filename}' and '${unitFolderId}' in parents and trashed=false`,
      fields: 'files(id,name)',
    });
    if (existingCheck.data.files.length > 0) {
      const existingId = existingCheck.data.files[0].id;
      console.log('Duplicate prevented:', filename);
      const photoUrl = `https://drive.google.com/uc?export=view&id=${existingId}`;
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, fileId: existingId, filename, photoUrl, duplicate: true }),
      };
    }

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

    // Make file publicly readable for email embedding
    await drive.permissions.create({
      fileId: uploaded.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    const photoUrl = `https://drive.google.com/uc?export=view&id=${uploaded.data.id}`;
    console.log('SUCCESS:', uploaded.data.name, '| ID:', uploaded.data.id);

    // Look up resident emails from Google Sheet
    const recipients = await getResidentEmails(auth, unit);
    console.log('Recipients for unit', unit, ':', recipients.length);

    // Schedule confirmation email with 2-minute delay
    if (recipients.length > 0 && deliveryId) {
      const timer = setTimeout(async () => {
        try {
          await sendConfirmationEmail(recipients, unit, filename, photoUrl);
          delete pendingEmails[deliveryId];
        } catch(e) {
          console.log('Email error:', e.message);
        }
      }, 2 * 60 * 1000);
      pendingEmails[deliveryId] = timer;
      console.log('Email scheduled in 2 min for:', deliveryId);
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
