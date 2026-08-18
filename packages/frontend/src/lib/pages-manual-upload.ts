import { gunzip, gzip, unzip } from "fflate";

const TAR_BLOCK_SIZE = 512;
const ROOT_ENTRYPOINTS = new Set(["index.html", "index.htm"]);
const encoder = new TextEncoder();

export interface PreparedPageBuild {
  archive: File;
  fileCount: number;
  sourceLabel: string;
}

interface BuildEntry {
  path: string;
  bytes: Uint8Array;
  modifiedAt: number;
}

function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read the selected build"));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob);
  });
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function normalizePath(raw: string): string {
  const normalized = raw.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.includes("\0")
  ) {
    throw new Error("The build contains an invalid file path");
  }
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) {
    throw new Error("The build contains a file outside its root");
  }
  return parts.join("/");
}

function hasRootEntrypoint(paths: Iterable<string>): boolean {
  for (const path of paths) {
    if (ROOT_ENTRYPOINTS.has(path)) return true;
  }
  return false;
}

function requireRootEntrypoint(paths: Iterable<string>): void {
  if (!hasRootEntrypoint(paths)) {
    throw new Error("The build must contain index.html or index.htm at its root");
  }
}

function stripCommonWrapper(entries: BuildEntry[]): BuildEntry[] {
  if (hasRootEntrypoint(entries.map((entry) => entry.path))) return entries;
  const firstSegment = entries[0]?.path.split("/", 1)[0];
  if (!firstSegment || entries.some((entry) => !entry.path.startsWith(`${firstSegment}/`))) {
    return entries;
  }
  const stripped = entries.map((entry) => ({
    ...entry,
    path: entry.path.slice(firstSegment.length + 1),
  }));
  return hasRootEntrypoint(stripped.map((entry) => entry.path)) ? stripped : entries;
}

function promisifyCompression(
  operation: (
    data: Uint8Array,
    callback: (error: Error | null, result: Uint8Array) => void
  ) => unknown,
  data: Uint8Array
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    operation(data, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function unzipArchive(data: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(data, (error, result) => {
      if (error) reject(new Error("The ZIP archive is invalid"));
      else resolve(result);
    });
  });
}

function readTarString(block: Uint8Array, start: number, length: number): string {
  let end = start;
  const limit = start + length;
  while (end < limit && block[end] !== 0) end += 1;
  return new TextDecoder().decode(block.subarray(start, end));
}

function inspectTarEntrypoint(tar: Uint8Array): number {
  let offset = 0;
  let fileCount = 0;
  let found = false;
  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const rawSize = readTarString(header, 124, 12).trim();
    const size = rawSize ? Number.parseInt(rawSize, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("The tar.gz archive is invalid");
    const type = String.fromCharCode(header[156] || 48);
    if (type === "0") {
      const path = normalizePath(prefix ? `${prefix}/${name}` : name);
      fileCount += 1;
      if (ROOT_ENTRYPOINTS.has(path)) found = true;
    }
    offset += TAR_BLOCK_SIZE + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  if (!found) throw new Error("The build must contain index.html or index.htm at its root");
  return fileCount;
}

function splitTarPath(path: string): { name: Uint8Array; prefix: Uint8Array } {
  const pathBytes = encoder.encode(path);
  if (pathBytes.length <= 100) return { name: pathBytes, prefix: new Uint8Array() };
  const slashes = [...path.matchAll(/\//g)].map((match) => match.index ?? -1).reverse();
  for (const slash of slashes) {
    const prefix = encoder.encode(path.slice(0, slash));
    const name = encoder.encode(path.slice(slash + 1));
    if (prefix.length <= 155 && name.length <= 100) return { name, prefix };
  }
  throw new Error(`The build path is too long: ${path}`);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const encoded = encoder.encode(`${value.toString(8).padStart(length - 1, "0")}\0`);
  target.set(encoded, offset);
}

function createTar(entries: BuildEntry[]): Uint8Array {
  const totalBytes =
    entries.reduce(
      (total, entry) =>
        total + TAR_BLOCK_SIZE + Math.ceil(entry.bytes.length / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE,
      0
    ) +
    TAR_BLOCK_SIZE * 2;
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const entry of entries) {
    const header = output.subarray(offset, offset + TAR_BLOCK_SIZE);
    const { name, prefix } = splitTarPath(entry.path);
    header.set(name, 0);
    header.set(prefix, 345);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.bytes.length);
    writeOctal(header, 136, 12, Math.floor(entry.modifiedAt / 1000));
    header.fill(32, 148, 156);
    header[156] = "0".charCodeAt(0);
    header.set(encoder.encode("ustar\0"), 257);
    header.set(encoder.encode("00"), 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.set(encoder.encode(`${checksum.toString(8).padStart(6, "0")}\0 `), 148);
    offset += TAR_BLOCK_SIZE;
    output.set(entry.bytes, offset);
    offset += Math.ceil(entry.bytes.length / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  return output;
}

async function packEntries(entries: BuildEntry[], sourceLabel: string): Promise<PreparedPageBuild> {
  const normalized = stripCommonWrapper(entries);
  requireRootEntrypoint(normalized.map((entry) => entry.path));
  const tar = createTar(normalized);
  const compressed = await new Promise<Uint8Array>((resolve, reject) => {
    gzip(tar, { level: 6 }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
  return {
    archive: new File([ownedArrayBuffer(compressed)], "site.tar.gz", {
      type: "application/gzip",
    }),
    fileCount: normalized.length,
    sourceLabel,
  };
}

export async function preparePageArchive(file: File): Promise<PreparedPageBuild> {
  const name = file.name.toLowerCase();
  const bytes = await readBlobBytes(file);
  if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) {
    let tar: Uint8Array;
    try {
      tar = await promisifyCompression((data, callback) => gunzip(data, callback), bytes);
    } catch {
      throw new Error("The tar.gz archive is invalid");
    }
    return { archive: file, fileCount: inspectTarEntrypoint(tar), sourceLabel: file.name };
  }
  if (!name.endsWith(".zip")) throw new Error("Choose a .zip or .tar.gz archive");
  const files = await unzipArchive(bytes);
  const entries = Object.entries(files)
    .filter(([path]) => !path.endsWith("/"))
    .map(([path, content]) => ({
      path: normalizePath(path),
      bytes: content,
      modifiedAt: file.lastModified,
    }));
  if (entries.length === 0) throw new Error("The archive contains no files");
  return packEntries(entries, file.name);
}

export async function preparePageFolder(files: File[]): Promise<PreparedPageBuild> {
  if (files.length === 0) throw new Error("Choose a folder containing a static build");
  const entries = await Promise.all(
    files.map(async (file) => ({
      path: normalizePath(file.webkitRelativePath || file.name),
      bytes: await readBlobBytes(file),
      modifiedAt: file.lastModified,
    }))
  );
  const folderName = entries[0]?.path.split("/", 1)[0] || "folder";
  return packEntries(entries, folderName);
}

export async function sha256Hex(file: Blob): Promise<string> {
  const bytes = await readBlobBytes(file);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return sha256Fallback(bytes);
}

function sha256Fallback(bytes: Uint8Array): string {
  const rotations = [7, 18, 3, 17, 19, 10, 6, 11, 25, 2, 13, 22];
  const constants = new Uint32Array(64);
  const state = new Uint32Array(8);
  let prime = 2;
  let constantsIndex = 0;
  while (constantsIndex < 64) {
    let isPrime = true;
    for (let factor = 2; factor * factor <= prime; factor += 1) {
      if (prime % factor === 0) {
        isPrime = false;
        break;
      }
    }
    if (isPrime) {
      if (constantsIndex < 8) state[constantsIndex] = (Math.sqrt(prime) * 2 ** 32) >>> 0;
      constants[constantsIndex] = (Math.cbrt(prime) * 2 ** 32) >>> 0;
      constantsIndex += 1;
    }
    prime += 1;
  }

  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = BigInt(bytes.length) * 8n;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Number(bitLength >> 32n), false);
  view.setUint32(paddedLength - 4, Number(bitLength & 0xffff_ffffn), false);

  const words = new Uint32Array(64);
  for (let block = 0; block < paddedLength; block += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(block + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const first = words[index - 15];
      const second = words[index - 2];
      const sigma0 =
        ((first >>> rotations[0]) | (first << (32 - rotations[0]))) ^
        ((first >>> rotations[1]) | (first << (32 - rotations[1]))) ^
        (first >>> rotations[2]);
      const sigma1 =
        ((second >>> rotations[3]) | (second << (32 - rotations[3]))) ^
        ((second >>> rotations[4]) | (second << (32 - rotations[4]))) ^
        (second >>> rotations[5]);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 =
        ((e >>> rotations[6]) | (e << (32 - rotations[6]))) ^
        ((e >>> rotations[7]) | (e << (32 - rotations[7]))) ^
        ((e >>> rotations[8]) | (e << (32 - rotations[8])));
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + constants[index] + words[index]) >>> 0;
      const sum0 =
        ((a >>> rotations[9]) | (a << (32 - rotations[9]))) ^
        ((a >>> rotations[10]) | (a << (32 - rotations[10]))) ^
        ((a >>> rotations[11]) | (a << (32 - rotations[11])));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}
