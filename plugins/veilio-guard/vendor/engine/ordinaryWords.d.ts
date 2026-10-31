import { type Language } from './languages.js';
/** A single dictionary word, written lower-case, Capitalised or in capitals. */
export declare function isOrdinaryWord(name: string): boolean;
/** Where configuration keeps its values, by grammar (`fileKindOf`). */
export type ValueGrammar = 'dotenv' | 'yaml' | 'shell' | 'ini' | 'xml';
export interface ValueSpan {
    start: number;
    end: number;
    value: string;
    /** Its key names a credential: under `redact` it is removed one-way. */
    credential: boolean;
    /** A path: its ordinary segments stay readable. Never a credential. */
    path: boolean;
    /** A bare name after a credential key in code (`password = sunshine`):
     *  perhaps a variable, so masked reversibly, never removed. */
    bare?: boolean;
}
export interface ValueScan {
    /** String literals, as the tokenizer found them: contents only. Absent:
     *  quoted runs on one line are taken as strings. */
    strings?: readonly {
        start: number;
        end: number;
        module?: boolean;
    }[];
    /** `code`: only strings are values. A grammar adds its own positions.
     *  Absent: text of no known kind - pasted text, a `.md`, command output -
     *  where every grammar applies, a bare name after a credential key too. */
    kind?: ValueGrammar | 'code';
    language?: Language;
}
/** Every value position in `text`, sorted by start. Spans may nest: a
 *  connection string's `password=...` lies inside its string. */
export declare function valueSpans(text: string, scan?: ValueScan): ValueSpan[];
/** The credential values among `spans`, never overlapping: the first wins. */
export declare function credentialsAmong(spans: readonly ValueSpan[]): ValueSpan[];
