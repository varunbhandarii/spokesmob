import { createHttpServer } from "../../server/src/http/server.js";

const server = await createHttpServer({ token: "synthetic-visual-harness", port: 4173 });
await server.listen();
console.log("Synthetic visual harness ready");
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void server.close();
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
