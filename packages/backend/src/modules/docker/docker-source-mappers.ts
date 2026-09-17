import type { dockerSourceBindings } from '@/db/schema/index.js';
export type SourceBindingRow = typeof dockerSourceBindings.$inferSelect;
export type SupportedSourceProvider = 'gitlab' | 'github' | 'git';
