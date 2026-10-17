import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

// WebWorker dedicado para WebLLM: mantiene el engine fuera del hilo UI
// para no congelar el editor mientras descarga/piensa.
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg: MessageEvent) => {
  handler.onmessage(msg);
};
