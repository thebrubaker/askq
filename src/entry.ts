import { main } from "./cli";

// A signal stops askq taking new items, but the run still finishes the ones in flight and
// accounts for every input line before exiting. A killed run that leaves a short output file
// and no summary is the failure this tool exists to prevent — including when the thing doing
// the killing is a timeout in someone's script.
const controller = new AbortController();
let signalled = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (signalled) process.exit(130);
    signalled = true;
    process.stderr.write(`askq: ${signal} — finishing the items in flight, then reporting\n`);
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
