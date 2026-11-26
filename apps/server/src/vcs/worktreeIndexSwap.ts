import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

// Each T3 Git command holds one permit and a swap takes them all. Smaller requests overtake a
// waiting larger one, so a swap waits for the commands already running in its worktree, and
// later commands wait only while it holds index.lock. Module-wide: both Git runners use it.
const SWAP_PERMITS = Number.MAX_SAFE_INTEGER;
const swaps = new Map<string, Semaphore.Semaphore>();

const swapContaining = (cwd: string) => {
  for (const [root, gate] of swaps) {
    if (cwd === root || cwd.startsWith(`${root}/`) || cwd.startsWith(`${root}\\`)) return gate;
  }
  return undefined;
};

/**
 * Registers a pending index swap for the worktree at `roots` (its path spellings). `exclusive`
 * runs the swap's lock-holding step while no T3 Git command runs in the worktree; `release`
 * ends the registration.
 */
export const reserveIndexSwap = (roots: ReadonlyArray<string>) =>
  Effect.sync(() => {
    const gate = Semaphore.makeUnsafe(SWAP_PERMITS);
    for (const root of roots) swaps.set(root, gate);
    return {
      exclusive: gate.withPermits(SWAP_PERMITS),
      release: Effect.sync(() => {
        for (const root of roots) if (swaps.get(root) === gate) swaps.delete(root);
      }),
    };
  });

/** Runs a T3 Git command in `cwd` outside any index swap of a worktree containing it. */
export const outsideIndexSwap = <A, E, R>(cwd: string, command: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const gate = swapContaining(cwd);
    if (gate === undefined) return command;
    return gate
      .withPermitsIfAvailable(1)(command)
      .pipe(
        Effect.flatMap((ran) =>
          Option.isSome(ran)
            ? Effect.succeed(ran.value)
            : gate.withPermit(command).pipe(Effect.withSpan("GitVcsDriver.afterIndexSwap")),
        ),
      );
  });
