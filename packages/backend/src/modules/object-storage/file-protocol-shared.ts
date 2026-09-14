/** Content types guessed from a file extension — file protocols carry no metadata. */
const CONTENT_TYPES: Record<string, string> = {
  css: 'text/css',
  csv: 'text/csv',
  gif: 'image/gif',
  gz: 'application/gzip',
  html: 'text/html',
  htm: 'text/html',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript',
  json: 'application/json',
  md: 'text/markdown',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  tar: 'application/x-tar',
  txt: 'text/plain',
  webp: 'image/webp',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  zip: 'application/zip',
};

export function guessContentType(key: string): string {
  const extension = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

/** Splits an object key into its parent directory and file name. */
export function splitKey(key: string): { parent: string; name: string } {
  const index = key.lastIndexOf('/');
  return index === -1 ? { parent: '', name: key } : { parent: key.slice(0, index), name: key.slice(index + 1) };
}

/**
 * Recursive listings have no server-side pagination on file protocols, so a
 * walk is bounded here to keep one request from enumerating an entire disk.
 */
export const MAX_RECURSIVE_ENTRIES = 5_000;
export const MAX_RECURSIVE_DEPTH = 32;
