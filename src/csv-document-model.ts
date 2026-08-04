import Papa, { ParseError } from 'papaparse';

export type CsvSnapshot = {
  rows: string[][];
  errors: ParseError[];
  delimiter: string;
  lineEnding: '\r\n' | '\n' | '\r';
  hasBom: boolean;
};

export class CsvDocumentModel {
  // Cache keyed only by document version + delimiter. We intentionally do NOT
  // retain the full document text: for large CSVs that would double the memory
  // footprint (the VS Code document already owns the text) and the previous
  // `text === text` identity check was an O(n) string compare. VS Code bumps the
  // document version on every edit, so (version, delimiter) uniquely identifies
  // a parsed snapshot within a session.
  private cached:
    | { version: number; delimiter: string; snapshot: CsvSnapshot }
    | undefined;

  public read(version: number, text: string, delimiter: string): CsvSnapshot {
    if (this.cached?.version === version && this.cached.delimiter === delimiter) {
      return this.cached.snapshot;
    }
    const hasBom = text.charCodeAt(0) === 0xfeff;
    const content = hasBom ? text.slice(1) : text;
    const result = Papa.parse<string[]>(content, { delimiter, dynamicTyping: false });
    const snapshot: CsvSnapshot = {
      rows: result.data.map(row => row.map(value => String(value ?? ''))),
      errors: result.errors,
      delimiter,
      lineEnding: content.includes('\r\n') ? '\r\n' : content.includes('\r') ? '\r' : '\n',
      hasBom
    };
    this.cached = { version, delimiter, snapshot };
    return snapshot;
  }

  public serialize(rows: string[][], snapshot: CsvSnapshot): string {
    const body = Papa.unparse(rows, {
      delimiter: snapshot.delimiter,
      newline: snapshot.lineEnding
    });
    return snapshot.hasBom ? `﻿${body}` : body;
  }

  public invalidate(): void {
    this.cached = undefined;
  }
}
