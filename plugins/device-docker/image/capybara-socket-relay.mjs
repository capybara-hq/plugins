// capybara-socket-relay <socket>: one connection to a device service's unix socket, relayed over
// stdin / stdout byte for byte (device-docker / device-e2b src/services.ts, SOCKET_RELAY_SOURCE).
import { connect } from "node:net";

const path = process.argv[process.argv.length - 1];
const sock = connect(path);
let connected = false;
sock.on("connect", () => {
  connected = true;
  process.stderr.write("ready\n");
  process.stdin.on("data", (chunk) => {
    if (!sock.write(chunk)) process.stdin.pause();
  });
  sock.on("drain", () => process.stdin.resume());
  process.stdin.on("end", () => sock.destroy());
  process.stdin.on("error", () => sock.destroy());
  sock.pipe(process.stdout);
});
sock.on("error", (e) => {
  if (!connected) {
    process.stderr.write(`capybara-socket-relay: cannot connect: ${e.code ?? e.message}\n`);
    process.exit(3);
  }
});
sock.on("close", () => {
  process.stdout.end(() => process.exit(0));
});
process.stdout.on("error", () => process.exit(0));
