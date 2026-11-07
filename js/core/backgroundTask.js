// Background reads belong in the script journal, not the foreground execution queue.
// Journal failures must never block the actual read. Only caller-owned fixed messages are logged.
export function backgroundTask(title) {
  const pending = import('./taskLog.js')
    .then(({ startTask }) => startTask(`Фоновая задача: ${title}`, { dock: false }))
    .catch(() => null);
  return {
    log(text) {
      void pending.then(task => task?.log(text)).catch(() => {});
    },
    finish(summary, status = 'done') {
      void pending.then(task => task?.finish(summary, status)).catch(() => {});
    }
  };
}
