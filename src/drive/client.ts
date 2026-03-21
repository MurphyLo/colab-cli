import { google, drive_v3 } from 'googleapis';
import { Readable } from 'stream';
import fs from 'fs';

// --- Types ---

export interface DriveFileInfo {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  parents?: string[];
  md5Checksum?: string;
}

export interface DriveListResult {
  files: DriveFileInfo[];
  nextPageToken?: string | null;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

// --- Client creation ---

function createDriveClient(accessToken: string): drive_v3.Drive {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });

  return google.drive({ version: 'v3', auth });
}

// --- File operations ---

export async function listFiles(
  token: string,
  parentId?: string,
  pageToken?: string,
): Promise<DriveListResult> {
  const drive = createDriveClient(token);
  const q = `'${parentId || 'root'}' in parents and trashed = false`;
  const res = await drive.files.list({
    q,
    fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, parents, md5Checksum)',
    pageSize: 100,
    orderBy: 'folder,name',
    pageToken: pageToken || undefined,
  });

  const files: DriveFileInfo[] = (res.data.files || []).map((f) => ({
    id: f.id!,
    name: f.name!,
    mimeType: f.mimeType!,
    size: f.size ?? undefined,
    modifiedTime: f.modifiedTime ?? undefined,
    parents: (f.parents as string[]) ?? undefined,
    md5Checksum: f.md5Checksum ?? undefined,
  }));

  return { files, nextPageToken: res.data.nextPageToken };
}

export async function getFileMetadata(
  token: string,
  fileId: string,
): Promise<DriveFileInfo> {
  const drive = createDriveClient(token);
  const res = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size, modifiedTime, parents, md5Checksum',
  });
  return {
    id: res.data.id!,
    name: res.data.name!,
    mimeType: res.data.mimeType!,
    size: res.data.size ?? undefined,
    modifiedTime: res.data.modifiedTime ?? undefined,
    parents: (res.data.parents as string[]) ?? undefined,
    md5Checksum: res.data.md5Checksum ?? undefined,
  };
}

export async function downloadFile(
  token: string,
  fileId: string,
  destPath: string,
  onProgress?: (bytesDownloaded: number) => void,
): Promise<void> {
  const drive = createDriveClient(token);
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' },
  );

  const stream = res.data as unknown as Readable;
  const writeStream = fs.createWriteStream(destPath);

  return new Promise<void>((resolve, reject) => {
    let bytesDownloaded = 0;
    stream.on('data', (chunk: Buffer) => {
      bytesDownloaded += chunk.length;
      onProgress?.(bytesDownloaded);
    });
    stream.on('error', reject);
    writeStream.on('error', reject);
    writeStream.on('finish', resolve);
    stream.pipe(writeStream);
  });
}

export async function createFolder(
  token: string,
  name: string,
  parentId?: string,
): Promise<string> {
  const drive = createDriveClient(token);
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId || 'root'],
    },
    fields: 'id',
  });
  return res.data.id!;
}

export async function trashFile(token: string, fileId: string): Promise<void> {
  const drive = createDriveClient(token);
  await drive.files.update({
    fileId,
    requestBody: { trashed: true },
  });
}

export async function permanentlyDelete(token: string, fileId: string): Promise<void> {
  const drive = createDriveClient(token);
  await drive.files.delete({ fileId });
}

export async function moveFile(
  token: string,
  fileId: string,
  newParentId: string,
): Promise<void> {
  const drive = createDriveClient(token);
  // Get current parents
  const meta = await getFileMetadata(token, fileId);
  const previousParents = (meta.parents || []).join(',');

  await drive.files.update({
    fileId,
    addParents: newParentId,
    removeParents: previousParents,
    fields: 'id, parents',
  });
}

export async function findFileByName(
  token: string,
  fileName: string,
  parentId: string,
): Promise<DriveFileInfo | undefined> {
  const drive = createDriveClient(token);
  const q = `name = '${fileName.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`;
  const res = await drive.files.list({
    q,
    fields: 'files(id, name, mimeType, size, md5Checksum)',
    pageSize: 1,
  });
  const files = res.data.files || [];
  if (files.length === 0) return undefined;
  const f = files[0];
  return {
    id: f.id!,
    name: f.name!,
    mimeType: f.mimeType!,
    size: f.size ?? undefined,
    md5Checksum: f.md5Checksum ?? undefined,
  };
}

export { FOLDER_MIME };
