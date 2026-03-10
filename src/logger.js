/**
 * Structured logger with levels: debug < info < warn < error
 */
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel = LEVELS.info;

function setLevel(level) {
  currentLevel = LEVELS[level] ?? LEVELS.info;
}

function formatTimestamp() {
  return new Date().toISOString();
}

function log(level, message, meta = {}) {
  if (LEVELS[level] < currentLevel) return;

  const entry = {
    timestamp: formatTimestamp(),
    level: level.toUpperCase(),
    message,
    ...meta,
  };

  const line = JSON.stringify(entry);

  switch (level) {
    case 'error': console.error(line); break;
    case 'warn':  console.warn(line);  break;
    default:      console.log(line);
  }
}

const logger = {
  setLevel,
  debug: (msg, meta) => log('debug', msg, meta),
  info:  (msg, meta) => log('info', msg, meta),
  warn:  (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
};

export default logger;
