import path from 'path';
import fs from 'fs';
import ora from 'ora';
import chalk from 'chalk';
import { DriveAuthManager } from '../drive/auth.js';
import {
  listFiles,
  getFileMetadata,
  downloadFile,
  createFolder,
  trashFile,
  permanentlyDelete,
  moveFile,
  FOLDER_MIME,
} from '../drive/client.js';
import { resumableUpload, type DriveUploadProgressEvent } from '../drive/resumable-upload.js';
import { formatBytes } from '../transfer/common.js';

// --- ID validation ---

/**
 * Warn (non-blocking) if a value looks like a filename/path rather than a Drive ID.
 * Drive IDs: [a-zA-Z0-9_-] only, typically 19–44 chars, minimum ~10.
 */
function warnIfNotId(value: string, label: string): void {
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

// --- List ---

export async function driveListCommand(
  driveAuth: DriveAuthManager,
  folderId?: string,
): Promise<void> {
  const token = await driveAuth.getAccessToken();
  const spinner = ora('Loading...').start();

  try {
    const parentId = folderId || 'root';
    if (folderId) warnIfNotId(folderId, 'folder ID');
    const result = await listFiles(token, parentId);
    spinner.stop();

    if (result.files.length === 0) {
      console.log('(empty)');
      return;
    }

    // Calculate column widths
    const nameWidth = Math.max(4, ...result.files.map((f) => displayName(f.name, f.mimeType).length));
    const sizeWidth = 10;

    for (const file of result.files) {
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
      console.log(`  ${icon}  ${name.padEnd(nameWidth + 2)} ${size}  ${date}  ${id}`);
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

  const token = await driveAuth.getAccessToken();
  const parentId = options.parent || 'root';
  if (options.parent) warnIfNotId(options.parent, 'parent folder ID');
  const spinner = ora('Uploading...').start();

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
        spinner.info(`Skipped ${event.fileName}: ${event.reason} (ID: ${event.fileId})`);
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
  warnIfNotId(fileId, 'file ID');
  const token = await driveAuth.getAccessToken();
  const spinner = ora('Fetching file info...').start();

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
    spinner.succeed(`Downloaded ${meta.name} -> ${destPath} (${formatBytes(totalBytes)})`);
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
  const token = await driveAuth.getAccessToken();
  const parentId = parent || 'root';
  if (parent) warnIfNotId(parent, 'parent folder ID');
  const spinner = ora(`Creating folder "${name}"...`).start();

  try {
    const folderId = await createFolder(token, name, parentId);
    spinner.succeed(`Created folder "${name}" (ID: ${folderId})`);
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
  warnIfNotId(fileId, 'file ID');
  const token = await driveAuth.getAccessToken();
  const spinner = ora('Deleting...').start();

  try {
    const meta = await getFileMetadata(token, fileId);
    if (options.permanent) {
      await permanentlyDelete(token, fileId);
      spinner.succeed(`Permanently deleted "${meta.name}" (${fileId})`);
    } else {
      await trashFile(token, fileId);
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
  fileId: string,
  toFolder: string,
): Promise<void> {
  warnIfNotId(fileId, 'file ID');
  warnIfNotId(toFolder, 'folder ID');
  const token = await driveAuth.getAccessToken();
  const spinner = ora('Moving...').start();

  try {
    const meta = await getFileMetadata(token, fileId);
    await moveFile(token, fileId, toFolder);
    spinner.succeed(`Moved "${meta.name}" to folder ${toFolder}`);
  } catch (err) {
    spinner.fail('Move failed');
    throw err;
  }
}
