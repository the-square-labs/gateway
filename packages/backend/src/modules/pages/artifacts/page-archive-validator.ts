export interface PageArchiveLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxExpandedBytes: number;
  maxPathBytes: number;
}
export interface PageArchiveValidationResult {
  fileCount: number;
  expandedSizeBytes: number;
}
