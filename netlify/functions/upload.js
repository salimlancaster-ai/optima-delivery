const { google } = require('googleapis');
const sgMail = require('@sendgrid/mail');
const https = require('https');

const ROOT_FOLDER_ID = '1UOHnLXymieQLCPd9KqNsjNwjyZHA99xU';
const SHEET_ID       = '1wtmUPwkRexC4hraveWVtC1me9RKIs1-NeAzHx3yMS2s';
const CLIENT_ID      = '450769207094-j35fdsvrv947qjtfndpcmrvfk1qbtse2.apps.googleusercontent.com';

// Cloudinary config
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'uditidi2';
const CLOUD_KEY  = process.env.CLOUDINARY_API_KEY    || '818969832744561';
const CLOUD_SEC  = process.env.CLOUDINARY_API_SECRET;

let cachedToken = null;
let tokenExpiry = null;
const pendingEmails = {};

// ── AUTH ───────────────────────────────────────────────────────
async function getAuthClient() {
  const oauth2Client = new google.auth.OAuth2(
    CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, 'http://localhost:3000'
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

// ── CLOUDINARY UPLOAD ──────────────────────────────────────────
async function uploadToCloudinary(base64Data, filename) {
  const crypto = require('crypto');
  const timestamp = Math.round(Date.now() / 1000);
  const publicId  = 'optima-deliveries/' + filename.replace('.jpg','');

  // Generate signature
  const sigStr = `public_id=${publicId}&timestamp=${timestamp}${CLOUD_SEC}`;
  const signature = crypto.createHash('sha1').update(sigStr).digest('hex');

  // Build multipart form data
  const boundary = '----FormBoundary' + Math.random().toString(36);
  const imgData  = base64Data.replace(/^data:image\/\w+;base64,/, '');

  const fields = {
    file:      'data:image/jpeg;base64,' + imgData,
    public_id: publicId,
    timestamp: String(timestamp),
    api_key:   CLOUD_KEY,
    signature: signature,
  };

  let body = '';
  for (const [key, val] of Object.entries(fields)) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`;
  }
  body += `--${boundary}--\r\n`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudinary.com',
      path:     `/v1_1/${CLOUD_NAME}/image/upload`,
      method:   'POST',
      headers: {
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.secure_url) {
            console.log('Cloudinary upload success:', parsed.secure_url);
            resolve(parsed.secure_url);
          } else {
            console.log('Cloudinary error:', data);
            reject(new Error(parsed.error?.message || 'Cloudinary upload failed'));
          }
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── GOOGLE DRIVE HELPERS ───────────────────────────────────────
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

// ── RESIDENT LOOKUP ────────────────────────────────────────────
async function getResidentEmails(auth, unit) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1!A:F',
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

// ── EMAIL TEMPLATE ─────────────────────────────────────────────
function buildEmailHtml(recipient, unit, filename, photoUrl, deliveryDate, deliveryTime) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#F4F4F4;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F4F4F4;padding:32px 16px">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:600px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,0.10)">
      <tr><td style="height:5px;background:#F5C800;font-size:0">&nbsp;</td></tr>
      <tr><td style="background:#111111;padding:28px 32px">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td><div style="display:inline-block;background:#F5C800;width:38px;height:38px;border-radius:7px;text-align:center;line-height:38px;font-size:20px;font-weight:900;color:#111111;vertical-align:middle">L</div>
          <span style="font-size:22px;font-weight:900;color:#ffffff;letter-spacing:2px;padding-left:12px;vertical-align:middle">LUXER ONE</span></td>
          <td align="right"><div style="display:inline-block;background:#F5C800;border-radius:20px;padding:6px 16px;font-size:10px;font-weight:800;color:#111111;letter-spacing:1.5px">IN-HOME DELIVERY</div></td>
        </tr></table>
      </td></tr>
      <tr><td style="background:#F5C800;padding:22px 32px">
        <table cellpadding="0" cellspacing="0"><tr>
          <td style="padding-right:16px"><div style="width:46px;height:46px;background:#111111;border-radius:50%;text-align:center;line-height:46px;font-size:22px;color:#F5C800">&#10003;</div></td>
          <td><div style="font-size:20px;font-weight:900;color:#111111">Package Delivered</div>
          <div style="font-size:12px;font-weight:600;color:rgba(17,17,17,0.6);margin-top:4px">Successfully placed inside your home</div></td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:32px 32px 20px">
        <p style="margin:0 0 14px;font-size:15px;color:#111111">Hi <strong>${recipient.name}</strong>,</p>
        <p style="margin:0;font-size:15px;color:#555555;line-height:1.8">Your in-home delivery has been successfully completed and placed inside your apartment by our concierge team. A photo confirmation is included below for your records.</p>
      </td></tr>
      <tr><td style="padding:0 32px 24px">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:8px;overflow:hidden;border:1.5px solid #E8E8E8">
          <tr><td colspan="3" style="padding:10px 16px;background:#111111"><div style="font-size:10px;font-weight:800;color:#F5C800;letter-spacing:2px;text-transform:uppercase">Delivery Details</div></td></tr>
          <tr>
            <td style="padding:16px;border-right:1.5px solid #E8E8E8;width:33%"><div style="font-size:9px;font-weight:700;color:#F5C800;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px">Unit</div><div style="font-size:24px;font-weight:900;color:#111111">${unit}</div></td>
            <td style="padding:16px;border-right:1.5px solid #E8E8E8;width:33%"><div style="font-size:9px;font-weight:700;color:#F5C800;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px">Delivered</div><div style="font-size:14px;font-weight:700;color:#111111">${deliveryDate}</div><div style="font-size:12px;color:#888888;margin-top:2px">${deliveryTime} CT</div></td>
            <td style="padding:16px;width:33%"><div style="font-size:9px;font-weight:700;color:#F5C800;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px">Reference</div><div style="font-family:monospace;font-size:11px;color:#888888;word-break:break-all">${filename}</div></td>
          </tr>
        </table>
      </td></tr>
      <tr><td style="padding:0 32px 28px">
        <div style="font-size:9px;font-weight:700;color:#888888;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;padding-bottom:8px;border-bottom:1.5px solid #E8E8E8">Delivery Photo</div>
        <img src="${photoUrl}" alt="Delivery Photo for Unit ${unit}" width="536" style="width:100%;max-width:536px;height:auto;display:block;border-radius:8px;border:1.5px solid #E8E8E8">
        <p style="margin:10px 0 0;font-size:11px;color:#aaaaaa;text-align:center;font-style:italic">Photo taken by concierge staff at time of delivery</p>
      </td></tr>
      <tr><td style="padding:0 32px 32px">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFBEA;border-radius:8px;border-left:4px solid #F5C800">
          <tr><td style="padding:14px 18px;font-size:13px;color:#333333;line-height:1.7"><strong style="color:#111111">Questions about your delivery?</strong><br>Please contact the package liaison team or visit the concierge desk.</td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:0 32px 24px">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td><div style="font-size:13px;font-weight:700;color:#111111;margin-bottom:5px">Optima Signature Management</div>
          <div style="font-size:12px;color:#888888;line-height:1.8">220 E. Illinois St., Chicago, IL 60611<br>
          <a href="mailto:liaisonos@luxerone.com" style="color:#111111;text-decoration:none;font-weight:600">liaisonos@luxerone.com</a></div></td>
          <td align="right"><div style="display:inline-block;background:#111111;border-radius:5px;padding:5px 12px;font-size:13px;font-weight:900;color:#F5C800;letter-spacing:1.5px">LUXER ONE</div></td>
        </tr></table>
      </td></tr>
      <tr><td style="background:#F5C800;padding:12px 32px;font-size:10px;color:rgba(17,17,17,0.55)">This is an automated delivery confirmation. Please do not reply to this email.</td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ── SEND EMAIL ─────────────────────────────────────────────────
async function sendConfirmationEmail(recipients, unit, filename, photoUrl) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  const now = new Date();
  const deliveryDate = now.toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' });
  const deliveryTime = now.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit' });

  for (const recipient of recipients) {
    const html = buildEmailHtml(recipient, unit, filename, photoUrl, deliveryDate, deliveryTime);
    await sgMail.send({
      to:      recipient.email,
      from:    { email: 'optimasignature.delivery@gmail.com', name: 'Optima Signature Deliveries' },
      subject: 'Package Delivered — Unit ' + unit,
      html,
    });
    console.log('Email sent to:', recipient.email);
  }
}

// ── MAIN HANDLER ───────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  try {
    const { filename, unit, imageData, deliveryId } = JSON.parse(event.body);

    const auth  = await getAuthClient();
    const drive = google.drive({ version: 'v3', auth });

    const now   = new Date();
    const month = now.toISOString().slice(0, 7);
    const date  = now.toISOString().slice(0, 10);

    // Build Drive folder structure
    const monthFolderId = await getOrCreateFolder(drive, month, ROOT_FOLDER_ID);
    const dateFolderId  = await getOrCreateFolder(drive, date, monthFolderId);
    const unitFolderId  = await getOrCreateFolder(drive, `Unit ${unit}`, dateFolderId);

    // Duplicate check
    const existing = await drive.files.list({
      q: `name='${filename}' and '${unitFolderId}' in parents and trashed=false`,
      fields: 'files(id)',
    });
    if (existing.data.files.length > 0) {
      console.log('Duplicate prevented:', filename);
      return { statusCode: 200, body: JSON.stringify({ success: true, duplicate: true, filename }) };
    }

    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const buffer     = Buffer.from(base64Data, 'base64');
    const { Readable } = require('stream');

    // Upload to Drive and Cloudinary simultaneously
    const [driveResult, cloudinaryUrl] = await Promise.allSettled([
      // Drive upload
      drive.files.create({
        requestBody: { name: filename, parents: [unitFolderId] },
        media: { mimeType: 'image/jpeg', body: Readable.from(buffer) },
        fields: 'id,name',
      }),
      // Cloudinary upload
      uploadToCloudinary(imageData, filename),
    ]);

    if (driveResult.status === 'rejected') throw new Error('Drive upload failed: ' + driveResult.reason.message);

    const fileId = driveResult.value.data.id;
    console.log('Drive upload success:', filename, '| ID:', fileId);

    // Use Cloudinary URL for email if available, fallback to Drive thumbnail
    const photoUrl = cloudinaryUrl.status === 'fulfilled'
      ? cloudinaryUrl.value
      : `https://drive.google.com/thumbnail?id=${fileId}&sz=w800`;

    console.log('Photo URL for email:', photoUrl);

    // Look up residents
    const recipients = await getResidentEmails(auth, unit);
    console.log('Recipients for unit', unit, ':', recipients.length);

    // Send confirmation email
    if (recipients.length > 0) {
      try {
        await sendConfirmationEmail(recipients, unit, filename, photoUrl);
        console.log('Email sent successfully for unit:', unit);
      } catch(e) {
        console.log('Email error:', JSON.stringify(e.response ? e.response.body : e.message));
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        fileId,
        filename,
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
