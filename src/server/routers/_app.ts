import { router } from "../trpc";
import { audioRouter } from "./audio";

export const appRouter = router({
  audio: audioRouter,
});

export type AppRouter = typeof appRouter;