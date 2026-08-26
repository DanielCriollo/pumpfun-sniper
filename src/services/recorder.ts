import fs from 'fs';
import nodePath from 'path';
import { config } from '../config';
import { logger } from '../logger';

// -----------------------------------------------------------
// Grabador de Firehose — datos para backtesting offline
// -----------------------------------------------------------
// Guarda todos los eventos `create` y los trades de los mints
// observados/en posición en data/firehose/YYYY-MM-DD.jsonl.
// Con esos archivos se pueden reproducir días enteros de mercado
// contra nuevas versiones de los filtros sin arriesgar SOL.
//
// Escritura buffereada (flush cada 2 s) para no bloquear el
// event loop con appends síncronos en un stream de alta frecuencia.
// -----------------------------------------------------------

const FIREHOSE_DIR = nodePath.join(process.cwd(), 'data', 'firehose');
const FLUSH_INTERVAL_MS = 2_000;
/** Techo de seguridad del buffer si el disco se atasca */
const MAX_BUFFER_LINES = 50_000;

let buffer: string[] = [];
let flushing = false;

export function recordFirehose(type: 'create' | 'trade', data: unknown): void {
  if (!config.RECORD_FIREHOSE) return;
  if (buffer.length >= MAX_BUFFER_LINES) return; // proteger memoria
  buffer.push(JSON.stringify({ t: Date.now(), type, data }));
}

function currentFile(): string {
  return nodePath.join(FIREHOSE_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
}

function flush(): void {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const lines = buffer;
  buffer = [];
  fs.appendFile(currentFile(), lines.join('\n') + '\n', 'utf8', (err) => {
    flushing = false;
    if (err) {
      logger.warn({ err: err.message, droppedLines: lines.length }, '⚠️  Firehose: fallo escribiendo');
    }
  });
}

export function startRecorder(): void {
  if (!config.RECORD_FIREHOSE) return;
  try {
    if (!fs.existsSync(FIREHOSE_DIR)) fs.mkdirSync(FIREHOSE_DIR, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, '⚠️  Firehose: no se pudo crear el directorio — grabación desactivada');
    return;
  }
  setInterval(flush, FLUSH_INTERVAL_MS);
  logger.info({ dir: FIREHOSE_DIR }, '🎥 Grabador de firehose activo (creates + trades observados)');
}
