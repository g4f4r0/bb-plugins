// Voice tools host entry: runs on the machine that does the recognition
// (the bb server's own machine) and owns the speech-server install and process.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, streamResultSchema } from "./src/contract.js";
import { Supervisor } from "./src/supervisor.js";

let supervisor: Supervisor | null = null;
/** Keeps the worker (and so the loaded model) alive between voice inputs. */
let lease: { dispose(): Promise<void> } | null = null;

function supervisorFor(dataDir: string): Supervisor {
  supervisor ??= new Supervisor(dataDir);
  return supervisor;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    "voiceTools.ensure": async ({ action, ...desired }, context) => {
      lease ??= context.experimental_retainWorker();
      return supervisorFor(context.experimental_paths.dataDir).ensure(desired, action);
    },
    "voiceTools.transcribe": async ({ audioBase64, filename, mimeType, hint }, context) => {
      const text = await supervisorFor(context.experimental_paths.dataDir).transcribe(
        Buffer.from(audioBase64, "base64"),
        filename,
        mimeType,
        hint,
        context.signal,
      );
      return { text };
    },
    "voiceTools.stream.start": async (_input, context) =>
      z.object({ id: z.string() }).parse(
        await supervisorFor(context.experimental_paths.dataDir).stream("/v1/stream", "POST", undefined, context.signal),
      ),
    "voiceTools.stream.audio": async ({ id, pcmBase64 }, context) =>
      streamResultSchema.parse(
        await supervisorFor(context.experimental_paths.dataDir).stream(
          `/v1/stream/${id}/audio`,
          "POST",
          new Uint8Array(Buffer.from(pcmBase64, "base64")),
          context.signal,
        ),
      ),
    "voiceTools.stream.finish": async ({ id }, context) =>
      streamResultSchema.parse(
        await supervisorFor(context.experimental_paths.dataDir).stream(
          `/v1/stream/${id}/finish`,
          "POST",
          undefined,
          context.signal,
        ),
      ),
    "voiceTools.stream.cancel": async ({ id }, context) => {
      await supervisorFor(context.experimental_paths.dataDir).stream(`/v1/stream/${id}`, "DELETE", undefined, context.signal);
      return {};
    },
    "voiceTools.stop": async (_input, context) => supervisorFor(context.experimental_paths.dataDir).stop(),
    "voiceTools.logs": async ({ lines }, context) => ({
      text: await supervisorFor(context.experimental_paths.dataDir).logs(lines),
    }),
  },
  dispose: async () => {
    await supervisor?.dispose();
    await lease?.dispose();
  },
});
