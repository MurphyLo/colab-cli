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
  ownedByMe?: boolean;
  ownerEmail?: string;
  ownerDisplayName?: string;
}

export interface DriveListResult {
  files: DriveFileInfo[];
  nextPageToken?: string | null;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Sentinel folder ID representing the virtual "Shared with me" collection.
 * Drive's real ID alphabet is [A-Za-z0-9_-] with lengths in the high teens
 * and up, so this short literal cannot collide with a real Drive ID.
 */
export const SHARED_WITH_ME_ID = 'shared';

const FILE_FIELDS = 'id, name, mimeType, size, modifiedTime, parents, md5Checksum, ownedByMe, owners(displayName,emailAddress)';

function mapFile(f: drive_v3.Schema$File): DriveFileInfo {
  const owner = f.owners?.[0];
  return {
    id: f.id!,
    name: f.name!,
    mimeType: f.mimeType!,
    size: f.size ?? undefined,
    modifiedTime: f.modifiedTime ?? undefined,
    parents: (f.parents as string[]) ?? undefined,
    md5Checksum: f.md5Checksum ?? undefined,
    ownedByMe: f.ownedByMe ?? undefined,
    ownerEmail: owner?.emailAddress ?? undefined,
    ownerDisplayName: owner?.displayName ?? undefined,
  };
}

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
  const isShared = parentId === SHARED_WITH_ME_ID;
  // "Shared with me" is a virtual collection: items have no parent in the
  // user's namespace, so we filter by sharedWithMe instead of an `in parents`
  // clause. The owner-name ordering matches Drive's web UI for this view.
  const q = isShared
    ? 'sharedWithMe = true and trashed = false'
    : `'${parentId || 'root'}' in parents and trashed = false`;
  const res = await drive.files.list({
    q,
    fields: `nextPageToken, files(${FILE_FIELDS})`,
    pageSize: 100,
    orderBy: isShared ? 'folder,sharedWithMeTime desc,name' : 'folder,name',
    pageToken: pageToken || undefined,
  });

  const files: DriveFileInfo[] = (res.data.files || []).map(mapFile);

  return { files, nextPageToken: res.data.nextPageToken };
}

export async function getFileMetadata(
  token: string,
  fileId: string,
): Promise<DriveFileInfo> {
  const drive = createDriveClient(token);
  const res = await drive.files.get({
    fileId,
    fields: FILE_FIELDS,
  });
  return mapFile(res.data);
}

export async function copyDriveItem(
  token: string,
  fileId: string,
  newParentId: string,
  newName?: string,
): Promise<DriveFileInfo> {
  const drive = createDriveClient(token);
  const res = await drive.files.copy({
    fileId,
    requestBody: {
      parents: [newParentId],
      ...(newName ? { name: newName } : {}),
    },
    fields: FILE_FIELDS,
  });
  return mapFile(res.data);
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

export async function moveDriveItem(
  token: string,
  itemId: string,
  newParentId: string,
): Promise<void> {
  const drive = createDriveClient(token);
  // Drive folders and regular files are both items whose parents can be updated.
  const meta = await getFileMetadata(token, itemId);
  const previousParents = (meta.parents || []).join(',');

  await drive.files.update({
    fileId: itemId,
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
    fields: `files(${FILE_FIELDS})`,
    pageSize: 1,
  });
  const files = res.data.files || [];
  if (files.length === 0) return undefined;
  return mapFile(files[0]);
}

export { FOLDER_MIME };
