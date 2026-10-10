function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export const log = {
  info: (...args) => console.log(stamp(), '·', ...args),
  warn: (...args) => console.warn(stamp(), '!', ...args),
  error: (...args) => console.error(stamp(), '✗', ...args),
};
