import Papa, { ParseError } from 'papaparse';

export type CsvSnapshot = {
  rows: string[][];
  errors: ParseError[];
  delimiter: string;
  lineEnding: '\r\n' | '\n' | '\r';
  hasBom: boolean;
};

export class CsvDocumentModel {
  private cached:
    | { version: number; delimiter: string; text: string; snapshot: CsvSnapshot }
    | undefined;

  public read(version: number, text: string, delimiter: string): CsvSnapshot {
    if (
      this.cached?.version === version &&
      this.cached.delimiter === delimiter &&
      this.cached.text === text
    ) {
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
    this.cached = { version, delimiter, text, snapshot };
    return snapshot;
  }

  public serialize(rows: string[][], snapshot: CsvSnapshot): string {
    const body = Papa.unparse(rows, {
      delimiter: snapshot.delimiter,
      newline: snapshot.lineEnding
    });
    return snapshot.hasBom ? `\ufeff${body}` : body;
  }

  public invalidate(): void {
    this.cached = undefined;
  }
}
