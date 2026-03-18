import { UUID } from 'crypto';

export function isUUID(value: string): value is UUID {
  const uuidRegex =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  return uuidRegex.test(value);
}

export function uuidToWebSafeBase64(uuid: UUID): string {
  return uuid.replace(/-/g, '_') + '.'.repeat(44 - uuid.length);
}
