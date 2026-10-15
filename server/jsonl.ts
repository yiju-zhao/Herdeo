import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';

/** Pi frames split only at LF; U+2028/U+2029 are valid JSON string content. */
export function readJsonLines(input: Readable, onMessage: (message: any) => void, onError: (error: Error) => void) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  input.on('data', chunk => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const row = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (row.length > 64 * 1024 * 1024) { onError(Error('JSONL frame exceeds 64 MiB')); return; }
      if (row) try { onMessage(JSON.parse(row)); } catch (error) { onError(error as Error); }
    }
    if (buffer.length > 64 * 1024 * 1024) { buffer = ''; onError(Error('JSONL frame exceeds 64 MiB')); }
  });
  input.on('end', () => { buffer += decoder.end(); if (buffer.trim()) onError(Error('Incomplete JSONL frame')); });
}
