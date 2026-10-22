// Minimal logger that keeps the last messages in memory for the debug overlay and bug reports.
const history = [];
const keep = (level, args) => {
  history.push({ t: Date.now(), level, msg: args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ') });
  if (history.length > 100) history.shift();
};

export const log = {
  info: (...a) => { keep('info', a); console.info('[blockwild]', ...a); },
  warn: (...a) => { keep('warn', a); console.warn('[blockwild]', ...a); },
  error: (...a) => { keep('error', a); console.error('[blockwild]', ...a); },
  history,
};
