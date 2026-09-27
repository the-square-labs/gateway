import type { CodeEditorLanguage } from "@/components/ui/code-editor";

export function imageMimeFromExtension(name: string) {
  const extension = name.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "apng":
    case "png":
      return "image/png";
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    case "gif":
      return "image/gif";
    case "jpg":
    case "jpeg":
    case "jfif":
    case "pjpeg":
    case "pjp":
      return "image/jpeg";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

export function imageMimeFromBytes(bytes: Uint8Array) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image/bmp";
  }
  return null;
}

export function imageMimeForFile(name: string, bytes: Uint8Array) {
  return imageMimeFromExtension(name) ?? imageMimeFromBytes(bytes);
}

export function isImageFileName(name: string) {
  return imageMimeFromExtension(name) !== null;
}

const EDITOR_LANGUAGE_BY_EXTENSION = new Map<string, CodeEditorLanguage>([
  ["conf", "nginx"],
  ["nginx", "nginx"],
  ["env", "env"],
  ["json", "json"],
  ["sql", "sql"],
  ["xml", "xml"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
]);

/**
 * The code editor language for a file, from its extension and then its media type. Files
 * without an extension inside an `nginx` directory are nginx config; the rest, Markdown
 * included, stay plain text.
 */
export function codeEditorLanguageForFile(
  path: string,
  mediaType?: string | null
): CodeEditorLanguage {
  const segments = path.toLowerCase().split("/");
  const name = segments.pop() ?? "";
  if (/^\.env(\..+)?$/.test(name)) return "env";
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const language = EDITOR_LANGUAGE_BY_EXTENSION.get(name.slice(dot + 1));
    if (language) return language;
  } else if (segments.includes("nginx")) {
    return "nginx";
  }

  const type = mediaType?.split(";")[0].trim().toLowerCase() ?? "";
  if (type === "application/json" || type.endsWith("+json")) return "json";
  if (/^(application|text)\/(x-)?yaml$/.test(type)) return "yaml";
  if (type === "application/xml" || type === "text/xml" || type.endsWith("+xml")) return "xml";
  if (type === "application/sql") return "sql";
  return "plain";
}
