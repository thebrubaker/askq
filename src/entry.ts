import { main } from "./cli";

const controller = new AbortController();
let signalled = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (signalled) process.exit(130);
    signalled = true;
    process.stderr.write(`askq: ${signal} — stopping the call, then writing what it has\n`);
    controller.abort();
  });
}

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`askq: internal: unhandled rejection: ${String(reason)}\n`);
  process.exit(1);
});
process.on("uncaughtException", (error: Error) => {
  process.stderr.write(`askq: internal: ${error.message}\n`);
  process.exit(1);
});

main(process.argv.slice(2), controller.signal)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: Error) => {
    process.stderr.write(`askq: internal: ${error.message}\n`);
    process.exitCode = 1;
  });
