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

const DATA_DIR = nodePath.join(process.cwd(), 'data');
const FIREHOSE_DIR = nodePath.join(DATA_DIR, 'firehose');
const REJECTIONS_FILE = nodePath.join(DATA_DIR, 'rejections.jsonl');
const FLUSH_INTERVAL_MS = 2_000;
/** Techo de seguridad del buffer si el disco se atasca */
const MAX_BUFFER_LINES = 50_000;

let fireBuffer: string[] = [];
let rejBuffer: string[] = [];

export function recordFirehose(type: 'create' | 'trade', data: unknown): void {
  if (!config.RECORD_FIREHOSE) return;
  if (fireBuffer.length >= MAX_BUFFER_LINES) return; // proteger memoria
  fireBuffer.push(JSON.stringify({ t: Date.now(), type, data }));
}

/**
 * Registra un rechazo de entrada con su razón — la materia prima para
 * saber qué filtro está descartando qué y ajustar con datos, no a ciegas.
 * Siempre activo (bajo volumen, alto valor).
 */
export function recordRejection(info: {
  mint: string;
  symbol?: string;
  reason: string;
  mcapSol?: number;
}): void {
  if (rejBuffer.length >= MAX_BUFFER_LINES) return;
  rejBuffer.push(JSON.stringify({ t: Date.now(), ...info }));
}

function firehoseFile(): string {
  return nodePath.join(FIREHOSE_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
}

function flushBuffer(buffer: string[], file: string, label: string): void {
  if (buffer.length === 0) return;
  const lines = buffer.splice(0);
  fs.appendFile(file, lines.join('\n') + '\n', 'utf8', (err) => {
    if (err) {
      logger.warn({ err: err.message, droppedLines: lines.length, label }, '⚠️  Recorder: fallo escribiendo');
    }
  });
}

function flushAll(): void {
  flushBuffer(fireBuffer, firehoseFile(), 'firehose');
  flushBuffer(rejBuffer, REJECTIONS_FILE, 'rejections');
}

export function startRecorder(): void {
  try {
    if (!fs.existsSync(FIREHOSE_DIR)) fs.mkdirSync(FIREHOSE_DIR, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, '⚠️  Recorder: no se pudo crear el directorio de datos');
    return;
  }
  setInterval(flushAll, FLUSH_INTERVAL_MS);
  logger.info(
    { firehose: config.RECORD_FIREHOSE, dir: DATA_DIR },
    '🎥 Recorder activo (rechazos siempre; firehose según config)',
  );
}
