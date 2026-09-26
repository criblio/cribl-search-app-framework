/**
 * Worked example: classify a photo with a GoatTown agent.
 *
 * This is the flow the Hotdog Detector got wrong, written the way the
 * client makes natural. Compiled and type-checked with the package, so it
 * cannot drift from the exports it demonstrates. It is NOT exported from
 * the public entry point — copy it, do not import it.
 *
 * The four steps matter in this order, and skipping any one of them is a
 * bug that produces a confident wrong answer rather than an error:
 *
 *  1. Create the session, and DRAIN the create request separately. Creating
 *     with a prompt starts work immediately, and that work answers the
 *     prompt — which at this point mentions no image. Its reply is
 *     "no image was attached", and it is a perfectly valid response to a
 *     different request.
 *  2. Preflight vision. `effective.vision` is the session's own send
 *     preflight; sending images to a session without it earns a 422 after
 *     the upload.
 *  3. Send the images and KEEP the receipt.
 *  4. Observe THAT receipt, from the cursor step 1 left behind.
 *
 * Domain parsing stays here, out of the framework: `verdictOf` is this
 * app's business, not the controller's.
 */
import { GoatTownClient } from './client.js';
import { SessionDiagnostics } from './diagnostics.js';
import { GoatTownError } from './errors.js';
import { runRequest, sendAndRun, type RequestResult } from './request.js';

export interface ClassifyInput {
  /** Raw base64 — no `data:` prefix. */
  imageBase64: string;
  mimeType: string;
  question?: string;
  agent?: string;
}

export type Verdict = 'hot-dog' | 'not-hot-dog' | 'undetermined';

export interface ClassifyOutcome {
  verdict: Verdict;
  /** Why, in the agent's words. Empty when nothing answered. */
  reason: string;
  /** The controller's own outcome, so a caller can tell "the agent could
   *  not tell" from "we never got to ask". */
  result: RequestResult;
  /** Redacted record of what happened on the wire. */
  diagnostics: ReturnType<SessionDiagnostics['snapshot']>;
}

export async function classifyPhoto(
  baseUrl: string,
  userId: () => Promise<string>,
  input: ClassifyInput,
  signal?: AbortSignal,
): Promise<ClassifyOutcome> {
  const diagnostics = new SessionDiagnostics();
  const client = new GoatTownClient({ baseUrl, userId, onDiagnostic: diagnostics.sink, fetch: undefined });

  // 1. Create, then drain the create request on its own. Its cursor is
  //    where the image request's observation must begin — starting at 0
  //    would replay this answer into the image request's transcript.
  const created = await client.createSession({
    prompt: 'A photo will follow. Wait for it before answering.',
    agent: input.agent,
    title: 'Image classification',
  }, signal);

  const initial = await runRequest(client, created.id, {
    requestId: created.requestId,
    since: 0,
    intervalMs: 1500,
    signal,
  });
  // Require COMPLETED, not merely "not a transport error". A create
  // request that failed, was stopped, stalled, or is untracked has not
  // established a session ready for the image — sending into one of those
  // produces an answer about a conversation that did not happen.
  if (initial.outcome !== 'completed') {
    return done(
      'undetermined',
      `The session's opening request ended as "${initial.outcome}" rather than completing, `
      + 'so no image was sent.',
      initial,
      diagnostics,
    );
  }

  // 2. Preflight. Configuration-level, but it is what the send checks.
  const llm = await client.readSessionLlm(created.id, signal);
  if (!llm.effective?.vision) {
    return done(
      'undetermined',
      'This session\'s model does not accept images. Ask an administrator to configure a '
      + 'vision-capable model, then retry.',
      initial,
      diagnostics,
    );
  }

  // 3 + 4. Send and observe the SAME receipt, resuming from the create
  //        request's cursor. `sendAndRun` makes discarding the receipt
  //        impossible — it is one call.
  let result: RequestResult;
  try {
    result = await sendAndRun(
      client,
      created.id,
      {
        content: input.question ?? 'Is this a hot dog? Answer HOT DOG or NOT HOT DOG, then explain.',
        images: [{ data: input.imageBase64, mimeType: input.mimeType }],
      },
      { since: initial.cursor, intervalMs: 1500, signal },
    );
  } catch (error) {
    // A 422 here means the model cannot see images. Never retry it as
    // text: that answers about a photo the model never received.
    if (error instanceof GoatTownError && error.isImageInputUnavailable) {
      return done('undetermined', error.message, initial, diagnostics);
    }
    throw error;
  }

  if (result.outcome !== 'completed') {
    // Explicitly NOT a verdict. "The request failed" and "the agent said it
    // could not tell" are different facts and must stay different.
    return done('undetermined', result.conclusion.text, result, diagnostics);
  }
  return done(verdictOf(result.conclusion.text), result.conclusion.text, result, diagnostics);
}

function done(
  verdict: Verdict,
  reason: string,
  result: RequestResult,
  diagnostics: SessionDiagnostics,
): ClassifyOutcome {
  return { verdict, reason, result, diagnostics: diagnostics.snapshot() };
}

/**
 * Domain parsing — deliberately outside the framework.
 *
 * Checks the negative first: "NOT HOT DOG" contains "HOT DOG", so matching
 * the positive first classifies every rejection as an acceptance.
 */
export function verdictOf(text: string): Verdict {
  const upper = text.toUpperCase();
  if (/\bNOT\s+(A\s+)?HOT[\s-]?DOG\b/.test(upper)) return 'not-hot-dog';
  if (/\bHOT[\s-]?DOG\b/.test(upper)) return 'hot-dog';
  return 'undetermined';
}
