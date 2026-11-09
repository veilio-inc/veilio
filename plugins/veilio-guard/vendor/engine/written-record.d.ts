/** The record's file name in `~/.veilio`. */
export declare const WRITTEN_RECORD_FILE = "written.json";
/** What is recorded for a project: the map's hash, then the aliases file's
 *  (an absent file hashes as the empty text). */
export declare function writtenRecordValue(mapSha256: string, aliasesSha256: string): string;
/** The record, real project root to value; null when it is not one. */
export declare function parseWrittenRecord(text: string): Record<string, string> | null;
