import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import { DriveAuthManager } from '../drive/auth.js';
import { startBackgroundAuth } from '../auth/background-auth.js';
import { createSpinner, isJsonMode, jsonResult, jsonError } from '../output/json-output.js';
import {
  listFiles,
  getFileMetadata,
  downloadFile,
  createFolder,
  trashFile,
  permanentlyDelete,
  moveDriveItem,
  copyDriveItem,
  FOLDER_MIME,
  SHARED_WITH_ME_ID,
  type DriveFileInfo,
} from '../drive/client.js';
import { resumableUpload, type DriveUploadProgressEvent } from '../drive/resumable-upload.js';
import { formatBytes } from '../transfer/common.js';

// --- Login / Logout / Status ---

export async function driveLoginCommand(
  driveAuth: DriveAuthManager,
): Promise<void> {
  if (driveAuth.isAuthorized()) {
    const email = driveAuth.getEmail();
    if (isJsonMode()) {
      jsonResult({ command: 'drive.login', alreadyLoggedIn: true, email: email ?? null });
    } else {
      console.log(`Already authorized${email ? ` as ${email}` : ''}.`);
    }
    return;
  }

  if (isJsonMode()) {
    await startBackgroundAuth('drive');
    return;
  }

  await driveAuth.ensureAuthorized();
  const email = driveAuth.getEmail();
  console.log(`Drive authorized${email ? ` as ${email}` : ''}.`);
}

export async function driveLogoutCommand(
  driveAuth: DriveAuthManager,
): Promise<void> {
  if (!driveAuth.isAuthorized()) {
    if (isJsonMode()) {
      jsonResult({ command: 'drive.logout', wasLoggedIn: false });
    } else {
      console.log('Not authorized.');
    }
    return;
  }
  const email = driveAuth.getEmail();
  await driveAuth.logout();
  if (isJsonMode()) {
    jsonResult({ command: 'drive.logout', wasLoggedIn: true, email: email ?? null });
  } else {
    console.log(`Drive authorization removed${email ? ` (${email})` : ''}.`);
  }
}

export async function driveStatusCommand(
  driveAuth: DriveAuthManager,
): Promise<void> {
  const authorized = driveAuth.isAuthorized();
  const email = authorized ? driveAuth.getEmail() : undefined;
  if (isJsonMode()) {
    jsonResult({ command: 'drive.status', authorized, email: email ?? null });
  } else if (authorized) {
    console.log(`Drive authorized${email ? ` (${email})` : ''}.`);
  } else {
    console.log('Drive not authorized. Run `colab drive login` to sign in.');
  }
}

// --- ID validation ---

/**
 * Warn (non-blocking) if a value looks like a filename/path rather than a Drive ID.
 * Drive IDs: [a-zA-Z0-9_-] only, typically 19–44 chars, minimum ~10.
 */
function warnIfNotId(value: string, label: string): void {
  // Allow our virtual sentinel ("shared") through without complaint.
  if (value === SHARED_WITH_ME_ID) return;

  // Contains characters outside the Drive ID charset
  const badChars = /[^a-zA-Z0-9_-]/.test(value);
  // Too short to be a real Drive ID (shortest known: ~19 for shared drives)
  const tooShort = value.length < 10;

  if (badChars || tooShort) {
    console.error(
      chalk.yellow(`Warning: "${value}" does not look like a Drive ID. Use "colab drive list" to find IDs.`),
    );
  }
}

/**
 * Synthetic entry that appears at the bottom of the My Drive root listing as
 * the user-facing entry point to "Shared with me". The id matches the sentinel
 * understood by listFiles, so the natural follow-up `drive list shared` works.
 */
function virtualSharedWithMeEntry(): DriveFileInfo {
  return {
    id: SHARED_WITH_ME_ID,
    name: 'Shared with me',
    mimeType: FOLDER_MIME,
  };
}

// --- List ---

export async function driveListCommand(
  driveAuth: DriveAuthManager,
  folderId?: string,
): Promise<void> {
  const token = await driveAuth.getAccessToken();
  const spinner = createSpinner('Loading...').start();

  try {
    const parentId = folderId || 'root';
    if (folderId) warnIfNotId(folderId, 'folder ID');
    const result = await listFiles(token, parentId);
    // Surface the "Shared with me" entry point as a virtual folder at the
    // bottom of the My Drive root listing, so users discover it without
    // any new flag or subcommand.
    const isRoot = parentId === 'root';
    const files = isRoot ? [...result.files, virtualSharedWithMeEntry()] : result.files;
    const isSharedView = parentId === SHARED_WITH_ME_ID;
    spinner.stop();

    if (isJsonMode()) {
      jsonResult({
        command: 'drive.list',
        parentId,
        files: files.map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: f.size ? parseInt(f.size, 10) : undefined,
          modifiedTime: f.modifiedTime,
          ownerEmail: f.ownerEmail,
          ownedByMe: f.ownedByMe,
        })),
      });
      return;
    }

    if (files.length === 0) {
      console.log('(empty)');
      return;
    }

    // Calculate column widths
    const nameWidth = Math.max(4, ...files.map((f) => displayName(f.name, f.mimeType).length));
    const sizeWidth = 10;
    // In the Shared with me view, also show the owner so users can tell
    // who shared each item with them.
    const ownerWidth = isSharedView
      ? Math.max(5, ...files.map((f) => (f.ownerEmail || '').length))
      : 0;

    for (const file of files) {
      const isFolder = file.mimeType === FOLDER_MIME;
      const icon = isFolder ? chalk.blue('D') : chalk.gray('F');
      const name = isFolder
        ? chalk.blue(file.name + '/')
        : file.name;
      const size = isFolder ? chalk.dim('—') : formatBytes(parseInt(file.size || '0', 10)).padStart(sizeWidth);
      const date = file.modifiedTime
        ? new Date(file.modifiedTime).toLocaleDateString()
        : '';
      const id = chalk.dim(file.id);
      const ownerCol = isSharedView
        ? '  ' + chalk.dim((file.ownerEmail || '').padEnd(ownerWidth))
        : '';
      console.log(`  ${icon}  ${name.padEnd(nameWidth + 2)} ${size}  ${date}${ownerCol}  ${id}`);
    }

    if (isRoot) {
      console.log(
        chalk.dim(`\n  Tip: "Shared with me" is a virtual folder. Run \`colab drive list shared\` to browse it.`),
      );
    }

    if (result.nextPageToken) {
      console.log(chalk.dim(`\n  ... more results available (pagination not yet shown)`));
    }
  } catch (err) {
    spinner.fail('Failed to list files');
    throw err;
  }
}

function displayName(name: string, mimeType: string): string {
  return mimeType === FOLDER_MIME ? name + '/' : name;
}

// --- Upload ---

export async function driveUploadCommand(
  driveAuth: DriveAuthManager,
  localPath: string,
  options: { parent?: string },
): Promise<void> {
  const resolvedPath = path.resolve(localPath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`File not found: ${resolvedPath}`);
    process.exit(1);
  }
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    console.error(`Not a file: ${resolvedPath}`);
    process.exit(1);
  }

  if (options.parent !== undefined && options.parent.trim() === '') {
    console.error('Error: --parent/-p is empty. Provide a valid folder ID or omit the flag.');
    process.exit(1);
  }
  if (options.parent === SHARED_WITH_ME_ID) {
    console.error('Error: "shared" is a virtual folder and cannot be used as an upload destination.');
    process.exit(1);
  }

  const token = await driveAuth.getAccessToken();
  const parentId = options.parent || 'root';
  if (options.parent) warnIfNotId(options.parent, 'parent folder ID');
  const spinner = createSpinner('Uploading...').start();

  let skippedResult: { fileName: string; reason: string; fileId: string } | undefined;

  const onProgress = (event: DriveUploadProgressEvent): void => {
    switch (event.type) {
      case 'start': {
        const resume = event.resuming ? ' (resuming)' : '';
        spinner.text = `Uploading ${event.fileName} (${formatBytes(event.totalBytes)})${resume}...`;
        break;
      }
      case 'progress': {
        const pct = Math.round((event.bytesUploaded / event.totalBytes) * 100);
        spinner.text = `Uploading... ${formatBytes(event.bytesUploaded)}/${formatBytes(event.totalBytes)} (${pct}%)`;
        break;
      }
      case 'skipped':
        if (isJsonMode()) {
          skippedResult = { fileName: event.fileName, reason: event.reason, fileId: event.fileId };
        } else {
          spinner.info(`Skipped ${event.fileName}: ${event.reason} (ID: ${event.fileId})`);
        }
        return;
      case 'done':
        break;
    }
  };

  try {
    const result = await resumableUpload(token, resolvedPath, {
      parentId,
      onProgress,
    });
    if (isJsonMode()) {
      if (skippedResult) {
        jsonResult({ command: 'drive.upload', skipped: true, ...skippedResult });
      } else {
        jsonResult({ command: 'drive.upload', fileId: result.fileId, fileName: result.fileName, totalBytes: result.totalBytes });
      }
      return;
    }
    // skipped case already handled by onProgress
    if (spinner.isSpinning) {
      spinner.succeed(
        `Uploaded ${result.fileName} (${formatBytes(result.totalBytes)}) -> Drive ID: ${result.fileId}`,
      );
    }
  } catch (err) {
    spinner.fail('Upload failed');
    throw err;
  }
}

// --- Download ---

export async function driveDownloadCommand(
  driveAuth: DriveAuthManager,
  fileId: string,
  options: { output?: string },
): Promise<void> {
  if (fileId === SHARED_WITH_ME_ID) {
    console.error('Error: "shared" is a virtual folder, not a file. Run `colab drive list shared` to find file IDs.');
    process.exit(1);
  }
  warnIfNotId(fileId, 'file ID');
  const token = await driveAuth.getAccessToken();
  const spinner = createSpinner('Fetching file info...').start();

  try {
    const meta = await getFileMetadata(token, fileId);

    if (meta.mimeType === FOLDER_MIME) {
      spinner.fail('Cannot download a folder. Use a file ID.');
      process.exit(1);
    }

    if (meta.mimeType.startsWith('application/vnd.google-apps.')) {
      spinner.fail(`Cannot download Google Workspace file (${meta.mimeType}). Export is not supported yet.`);
      process.exit(1);
    }

    const totalBytes = parseInt(meta.size || '0', 10);
    const destPath = path.resolve(options.output || meta.name);
    spinner.text = `Downloading ${meta.name} (${formatBytes(totalBytes)})...`;

    const onProgress = (bytesDownloaded: number): void => {
      if (totalBytes > 0) {
        const pct = Math.round((bytesDownloaded / totalBytes) * 100);
        spinner.text = `Downloading... ${formatBytes(bytesDownloaded)}/${formatBytes(totalBytes)} (${pct}%)`;
      } else {
        spinner.text = `Downloading... ${formatBytes(bytesDownloaded)}`;
      }
    };

    await downloadFile(token, fileId, destPath, onProgress);
    if (isJsonMode()) {
      jsonResult({ command: 'drive.download', name: meta.name, localPath: destPath, totalBytes });
    } else {
      spinner.succeed(`Downloaded ${meta.name} -> ${destPath} (${formatBytes(totalBytes)})`);
    }
  } catch (err) {
    spinner.fail('Download failed');
    throw err;
  }
}

// --- Mkdir ---

export async function driveMkdirCommand(
  driveAuth: DriveAuthManager,
  name: string,
  parent?: string,
): Promise<void> {
  if (parent !== undefined && parent.trim() === '') {
    console.error('Error: --parent/-p is empty. Provide a valid folder ID or omit the flag.');
    process.exit(1);
  }
  if (parent === SHARED_WITH_ME_ID) {
    console.error('Error: "shared" is a virtual folder and cannot contain new folders.');
    process.exit(1);
  }

  const token = await driveAuth.getAccessToken();
  const parentId = parent || 'root';
  if (parent) warnIfNotId(parent, 'parent folder ID');
  const spinner = createSpinner(`Creating folder "${name}"...`).start();

  try {
    const folderId = await createFolder(token, name, parentId);
    if (isJsonMode()) {
      jsonResult({ command: 'drive.mkdir', name, folderId, parentId });
    } else {
      spinner.succeed(`Created folder "${name}" (ID: ${folderId})`);
    }
  } catch (err) {
    spinner.fail('Failed to create folder');
    throw err;
  }
}

// --- Delete ---

export async function driveDeleteCommand(
  driveAuth: DriveAuthManager,
  fileId: string,
  options: { permanent?: boolean },
): Promise<void> {
  if (fileId === SHARED_WITH_ME_ID) {
    const msg = '"shared" is a virtual folder, not a real Drive item. It cannot be deleted.';
    if (isJsonMode()) jsonError(msg); else console.error(msg);
    process.exit(1);
  }
  warnIfNotId(fileId, 'file ID');
  const token = await driveAuth.getAccessToken();
  const spinner = createSpinner('Deleting...').start();

  try {
    const meta = await getFileMetadata(token, fileId);
    // Refuse early on shared (non-owned) files: only the owner can delete
    // them, and we deliberately don't manage permissions.
    if (meta.ownedByMe === false) {
      spinner.stop();
      const ownerLabel = meta.ownerEmail || meta.ownerDisplayName || 'someone else';
      const msg =
        `"${meta.name}" is shared with you (owner: ${ownerLabel}). ` +
        `You can only delete files you own.`;
      if (isJsonMode()) {
        jsonError(msg);
      } else {
        console.error(chalk.red('✗ Delete failed'));
        console.error(`  ${msg}`);
      }
      process.exit(1);
    }
    if (options.permanent) {
      await permanentlyDelete(token, fileId);
    } else {
      await trashFile(token, fileId);
    }
    if (isJsonMode()) {
      jsonResult({ command: 'drive.delete', name: meta.name, fileId, permanent: !!options.permanent });
    } else if (options.permanent) {
      spinner.succeed(`Permanently deleted "${meta.name}" (${fileId})`);
    } else {
      spinner.succeed(`Moved "${meta.name}" to trash (${fileId})`);
    }
  } catch (err) {
    spinner.fail('Delete failed');
    throw err;
  }
}

// --- Move ---

export async function driveMoveCommand(
  driveAuth: DriveAuthManager,
  itemId: string,
  toFolder: string,
): Promise<void> {
  if (itemId === SHARED_WITH_ME_ID) {
    const msg = '"shared" is a virtual folder, not a real Drive item. It cannot be moved.';
    if (isJsonMode()) jsonError(msg); else console.error(msg);
    process.exit(1);
  }
  if (toFolder === SHARED_WITH_ME_ID) {
    const msg = '"shared" is a virtual folder and cannot be used as a destination.';
    if (isJsonMode()) jsonError(msg); else console.error(msg);
    process.exit(1);
  }
  warnIfNotId(itemId, 'item ID');
  warnIfNotId(toFolder, 'folder ID');
  const token = await driveAuth.getAccessToken();
  const spinner = createSpinner('Moving...').start();

  try {
    const meta = await getFileMetadata(token, itemId);

    // For files the user doesn't own (typically Shared with me), a true move
    // is impossible: the item has no parent in the user's namespace to remove
    // from. We transparently fall back to a copy into the destination folder
    // and tell the user exactly what happened.
    if (meta.ownedByMe === false) {
      spinner.text = 'Copying (item is shared, cannot be moved)...';
      const copied = await copyDriveItem(token, itemId, toFolder);
      const ownerLabel = meta.ownerEmail || meta.ownerDisplayName || 'someone else';
      if (isJsonMode()) {
        jsonResult({
          command: 'drive.move',
          mode: 'copied',
          name: meta.name,
          itemId,
          toFolder,
          newFileId: copied.id,
          ownerEmail: meta.ownerEmail,
        });
      } else {
        spinner.succeed(`Copied "${meta.name}" into folder ${toFolder} (new ID: ${copied.id})`);
        console.error(
          chalk.dim(
            `  Note: this is a copy, not a move. "${meta.name}" is shared with you by\n` +
              `  ${ownerLabel} — you don't own it, so the original stays in Shared with me.\n` +
              `  The new copy is owned by you.`,
          ),
        );
      }
      return;
    }

    await moveDriveItem(token, itemId, toFolder);
    if (isJsonMode()) {
      jsonResult({ command: 'drive.move', mode: 'moved', name: meta.name, itemId, toFolder });
    } else {
      spinner.succeed(`Moved "${meta.name}" to folder ${toFolder}`);
    }
  } catch (err) {
    spinner.fail('Move failed');
    throw err;
  }
}
