// ── Optima Drive Cleanup Script ────────────────────────────────
// Deletes empty folders and duplicate photos from Google Drive
// Run once: node cleanup-drive.js
// ──────────────────────────────────────────────────────────────

const { google } = require('googleapis');
const readline = require('readline');

const CLIENT_ID     = '450769207094-j35fdsvrv947qjtfndpcmrvfk1qbtse2.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REFRESH_TOKEN = 'PASTE_YOUR_CURRENT_REFRESH_TOKEN_HERE';
const ROOT_FOLDER_ID = '1UOHnLXymieQLCPd9KqNsjNwjyZHA99xU';

async function getAuthClient() {
  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'http://localhost:3000');
  oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
  return oauth2Client;
}

async function listChildren(drive, parentId, mimeType) {
  let q = `'${parentId}' in parents and trashed=false`;
  if (mimeType) q += ` and mimeType='${mimeType}'`;
  const res = await drive.files.list({ q, fields: 'files(id,name,createdTime)', spaces: 'drive', pageSize: 1000 });
  return res.data.files || [];
}

async function deleteFile(drive, fileId, name, dryRun) {
  if (dryRun) {
    console.log('  [DRY RUN] Would delete:', name, '(' + fileId + ')');
  } else {
    await drive.files.delete({ fileId });
    console.log('  ✓ Deleted:', name);
  }
}

async function cleanup(dryRun = true) {
  console.log('\n' + (dryRun ? '🔍 DRY RUN — nothing will be deleted' : '🗑  LIVE RUN — deleting files') + '\n');

  const auth  = await getAuthClient();
  const drive = google.drive({ version: 'v3', auth });

  let totalEmptyFolders = 0;
  let totalDuplicates   = 0;
  let totalDeleted      = 0;

  // Get all month folders
  const monthFolders = await listChildren(drive, ROOT_FOLDER_ID, 'application/vnd.google-apps.folder');
  console.log(`Found ${monthFolders.length} month folder(s):`, monthFolders.map(f => f.name).join(', '));

  for (const monthFolder of monthFolders) {
    console.log(`\n📅 Month: ${monthFolder.name}`);

    const dateFolders = await listChildren(drive, monthFolder.id, 'application/vnd.google-apps.folder');
    console.log(`  Found ${dateFolders.length} date folder(s)`);

    for (const dateFolder of dateFolders) {
      const unitFolders = await listChildren(drive, dateFolder.id, 'application/vnd.google-apps.folder');

      // Delete empty date folders
      if (unitFolders.length === 0) {
        console.log(`  📁 Empty date folder: ${dateFolder.name}`);
        await deleteFile(drive, dateFolder.id, dateFolder.name, dryRun);
        totalEmptyFolders++;
        totalDeleted++;
        continue;
      }

      console.log(`  📅 Date: ${dateFolder.name} — ${unitFolders.length} unit folder(s)`);

      for (const unitFolder of unitFolders) {
        const files = await listChildren(drive, unitFolder.id, 'image/jpeg');

        // Delete empty unit folders
        if (files.length === 0) {
          console.log(`    📁 Empty unit folder: ${unitFolder.name}`);
          await deleteFile(drive, unitFolder.id, unitFolder.name, dryRun);
          totalEmptyFolders++;
          totalDeleted++;
          continue;
        }

        // Find duplicates — same filename, keep most recent
        const byName = {};
        files.forEach(f => {
          if (!byName[f.name]) byName[f.name] = [];
          byName[f.name].push(f);
        });

        let unitDupes = 0;
        for (const [name, copies] of Object.entries(byName)) {
          if (copies.length > 1) {
            // Sort by createdTime desc — keep first (newest), delete rest
            copies.sort((a,b) => new Date(b.createdTime) - new Date(a.createdTime));
            const toDelete = copies.slice(1);
            console.log(`    ⚠️  ${unitFolder.name}/${name} — ${copies.length} copies, keeping newest, deleting ${toDelete.length}`);
            for (const dupe of toDelete) {
              await deleteFile(drive, dupe.id, name, dryRun);
              unitDupes++;
              totalDeleted++;
            }
          }
        }
        if (unitDupes > 0) {
          totalDuplicates += unitDupes;
          console.log(`    ✓ ${unitFolder.name}: ${files.length} files, ${unitDupes} duplicates removed`);
        } else {
          console.log(`    ✓ ${unitFolder.name}: ${files.length} file(s), no duplicates`);
        }
      }
    }
  }

  console.log('\n─────────────────────────────────────────');
  console.log(`Empty folders found:   ${totalEmptyFolders}`);
  console.log(`Duplicate files found: ${totalDuplicates}`);
  console.log(`Total ${dryRun ? 'would delete' : 'deleted'}: ${totalDeleted} items`);
  if (dryRun) {
    console.log('\nRun with --live to actually delete these items');
  }
  console.log('─────────────────────────────────────────\n');
}

const isLive = process.argv.includes('--live');
cleanup(!isLive).catch(console.error);
