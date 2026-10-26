import http from "node:http";
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 8_000_000) throw new Error("request too large");
}
const request = http.request(
  {
    socketPath:
      process.env.PI_BOT_GUEST_SOCKET ||
      `/tmp/pibot-remote-${process.getuid()}.sock`,
    path: "/",
    method: "POST",
    headers: { "Content-Type": "application/json" },
  },
  (response) => response.pipe(process.stdout),
);
request.on("error", () => {
  process.stderr.write("remote guest unavailable\n");
  process.exitCode = 1;
});
for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"])
  process.on(signal, () => {
    request.destroy();
    process.exit(1);
  });
request.end(input);
