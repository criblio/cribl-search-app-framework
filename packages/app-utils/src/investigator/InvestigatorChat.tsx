/**
 * InvestigatorChat — embedded Copilot Investigator chat shell.
 *
 * Drives the agent loop in agent-loop.ts, renders the streaming
 * conversation, and mediates tool-call approvals. Apps embed it in
 * a route and inject everything app-specific: the tool definitions
 * advertised to the agent, the context payload, the tool executors,
 * the seed-prompt builder, and (optionally) custom result cards via
 * renderToolCard.
 *
 * Message timeline model: every user message, assistant response,
 * and tool call becomes an entry in `transcript`. Tool calls render
 * as approval cards inline; once executed, the card's rows table
 * replaces the approval buttons.
 *
 * The transcript rendering itself lives in InvestigatorTranscript
 * (same directory) — a driver-agnostic view this shell feeds its
 * live transcript state into. Surfaces that replay an investigation
 * from externally-received LoopEvents (e.g. a server-side run) use
 * that component directly and skip this shell entirely.
 *
 * Requires `@capra/core` (an optional peer dependency of this
 * package) for its Button and Modal components.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Button, Modal } from '@capra/core';
import { runInvestigation, type LoopEvent } from '../agent-loop.js';
import {
  isSessionExpiredError,
  type AgentContext,
  type AgentMessage,
  type AgentToolDefinition,
} from '../agent.js';
import type {
  ToolCallInvocation,
  ToolExecutionResult,
  ToolResultUi,
} from '../agent-tools.js';
import {
  InvestigatorTranscript,
  applyLoopEvent,
  type InvestigatorTranscriptEntry,
} from './InvestigatorTranscript.js';
import { exportAsPng } from './exportInvestigation.js';
import s from './InvestigatorChat.module.css';

// ─────────────────────────────────────────────────────────────────
// Seed model
// ─────────────────────────────────────────────────────────────────

/** The fields the shell itself understands on a seed. Apps may
 *  extend the seed with their own fields (service, topology, …) —
 *  the shell passes the whole object through to buildSeedPrompt /
 *  enrichSeed untouched. */
export interface InvestigatorSeedBase {
  /** The thing the user wants investigated — a short hypothesis or
   *  question. Becomes the first user message in the transcript. */
  question: string;
  /** Time range the user is looking at. */
  earliest?: string;
  latest?: string;
  /** Known anomaly signals (error rate delta, latency ratio, etc.)
   *  to include as "what we already know". */
  knownSignals?: string[];
}

/** Generic open-shape seed for apps that don't declare their own. */
export type InvestigatorSeed = InvestigatorSeedBase & Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────

function newSessionId(): string {
  // Matches the native UI's UUID shape — not strictly required, but
  // many Cribl analytics endpoints treat it as a conversation key.
  const rnd = () => Math.random().toString(16).slice(2, 10);
  return `${rnd()}-${rnd().slice(0, 4)}-${rnd().slice(0, 4)}-${rnd().slice(0, 4)}-${rnd()}${rnd().slice(0, 4)}`;
}

export interface InvestigatorChatProps<S extends InvestigatorSeedBase = InvestigatorSeed> {
  /** Optional seed to fire an investigation from on first mount —
   *  typically passed via router state from an "Investigate"
   *  button elsewhere in the app. */
  seed?: S;
  /** Header title. */
  title?: string;
  /** Header subtitle. */
  subtitle?: string;
  /** Headline shown in the empty state before any conversation. */
  emptyStateTitle?: string;
  /** Hint line under the empty-state headline. */
  emptyStateHint?: string;
  /** Canned prompts offered in the empty state. */
  emptyStateSuggestions?: string[];
  /** Expand a seed into the full first prompt (context preamble +
   *  question). Free-form composer submissions are wrapped in a
   *  {question} seed and run through the same builder. */
  buildSeedPrompt: (seed: S) => string;
  /** Optional async seed enrichment (time-window tightening,
   *  preflight signals, …) run before buildSeedPrompt. Failures
   *  should be handled inside — the shell awaits the result. */
  enrichSeed?: (seed: S) => Promise<S>;
  /** Tool definitions advertised to the agent. */
  toolDefinitions: AgentToolDefinition[];
  /** Build the request context sent with every POST. */
  buildContext: () => AgentContext | Promise<AgentContext>;
  /** Execute one client-side tool call. */
  executeToolCall: (
    call: ToolCallInvocation,
    signal?: AbortSignal,
  ) => Promise<ToolExecutionResult>;
  /** Which tool calls are gated on user approval. Omit to run every
   *  tool call immediately without pausing (the default). */
  requiresApproval?: (call: ToolCallInvocation) => boolean;
  /** Render a custom card for a tool result's UI payload. Called
   *  whenever a tool call entry has a result with `ui`; returning
   *  null/undefined falls through to the built-in cards for kind
   *  'search' and 'summary' (unknown kinds render nothing). */
  renderToolCard?: (ui: ToolResultUi, ctx: { entry: unknown }) => ReactNode | null;
  /** Called after the shell consumes the mount-time seed — apps
   *  typically clear their router state here so a reload doesn't
   *  re-fire the same investigation. */
  onSeedConsumed?: () => void;
  /** Analytics passthrough: receives every loop event along with
   *  the conversation's session id. */
  onSessionEvent?: (ev: LoopEvent, sessionId: string) => void;
}

export function InvestigatorChat<S extends InvestigatorSeedBase = InvestigatorSeed>({
  seed,
  title = 'Copilot Investigation',
  subtitle = 'AI-assisted root-cause analysis',
  emptyStateTitle,
  emptyStateHint = 'Ask a question about your data — or start from one of these:',
  emptyStateSuggestions = [],
  buildSeedPrompt,
  enrichSeed,
  toolDefinitions,
  buildContext,
  executeToolCall,
  requiresApproval,
  renderToolCard,
  onSeedConsumed,
  onSessionEvent,
}: InvestigatorChatProps<S>) {
  const [transcript, setTranscript] = useState<InvestigatorTranscriptEntry[]>([]);
  const [composerText, setComposerText] = useState('');
  const [running, setRunning] = useState(false);
  const [sessionId] = useState(newSessionId);

  const transcriptInnerRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const [exportedPng, setExportedPng] = useState<string | null>(null);

  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  // Approval gate: the loop calls this when it hits a tool call
  // that requiresApproval. We resolve the returned promise when the
  // user clicks "Run Query" or "Skip" on the inline card.
  const pendingApprovalRef = useRef<{
    callId: string;
    resolve: (approved: boolean) => void;
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const approveToolCall = useCallback(
    (call: { id: string }) =>
      new Promise<boolean>((resolve) => {
        pendingApprovalRef.current = { callId: call.id, resolve };
      }),
    [],
  );

  const resolveApproval = useCallback(
    (callId: string, approved: boolean) => {
      if (pendingApprovalRef.current?.callId === callId) {
        pendingApprovalRef.current.resolve(approved);
        pendingApprovalRef.current = null;
      }
      setTranscript((prev) =>
        prev.map((e) =>
          e.kind === 'toolCall' && e.call.id === callId
            ? { ...e, status: approved ? 'running' : 'skipped' }
            : e,
        ),
      );
    },
    [],
  );

  const handleLoopEvent = useCallback(
    (ev: LoopEvent) => {
      onSessionEvent?.(ev, sessionId);
      setTranscript((prev) => applyLoopEvent(prev, ev));
      if (ev.kind === 'done' || ev.kind === 'error') {
        setRunning(false);
      }
    },
    [onSessionEvent, sessionId],
  );

  const startInvestigation = useCallback(
    (initialMessages: AgentMessage[]) => {
      setRunning(true);
      abortRef.current?.abort();
      abortRef.current = new AbortController();

      runInvestigation({
        sessionId,
        initialMessages,
        toolDefinitions,
        buildContext,
        executeToolCall,
        requiresApproval,
        onEvent: handleLoopEvent,
        approveToolCall,
        signal: abortRef.current.signal,
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        const sessionExpired = isSessionExpiredError(err);
        setTranscript((prev) => [
          ...prev,
          { kind: 'error', id: `err-${Date.now()}`, message: msg, sessionExpired },
        ]);
        setRunning(false);
      });
    },
    [
      sessionId,
      toolDefinitions,
      buildContext,
      executeToolCall,
      requiresApproval,
      handleLoopEvent,
      approveToolCall,
    ],
  );

  const enrichAndBuildPrompt = useCallback(
    async (rawSeed: S): Promise<string> => {
      const enriched = enrichSeed ? await enrichSeed(rawSeed) : rawSeed;
      return buildSeedPrompt(enriched);
    },
    [enrichSeed, buildSeedPrompt],
  );

  // Seed the conversation on first mount if we arrived with a seed.
  const didSeedRef = useRef(false);
  useEffect(() => {
    if (didSeedRef.current) return;
    didSeedRef.current = true;
    if (!seed) return;
    setTranscript([
      {
        kind: 'user',
        id: `u-${Date.now()}`,
        content: seed.question,
      },
    ]);
    // Let the app clear the seed from its router state so a reload
    // doesn't re-fire the same investigation.
    onSeedConsumed?.();
    void (async () => {
      const prompt = await enrichAndBuildPrompt(seed);
      startInvestigation([
        { id: `m-${Date.now()}`, role: 'user', content: prompt, reqId: 0 },
      ]);
    })();
  }, [seed, startInvestigation, onSeedConsumed, enrichAndBuildPrompt]);

  const submitFreeForm = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || running) return;
      setTranscript((prev) => [
        ...prev,
        { kind: 'user', id: `u-${Date.now()}`, content: trimmed },
      ]);
      setComposerText('');
      void (async () => {
        // Free-form questions become a minimal seed. The cast is
        // safe for any S whose extra fields are all optional —
        // which the enrichSeed/buildSeedPrompt contract assumes.
        const freeSeed = { question: trimmed } as S;
        const prompt = await enrichAndBuildPrompt(freeSeed);
        startInvestigation([
          { id: `m-${Date.now()}`, role: 'user', content: prompt, reqId: 0 },
        ]);
      })();
    },
    [running, startInvestigation, enrichAndBuildPrompt],
  );

  const handleComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitFreeForm(composerText);
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    setRunning(false);
    // Resolve any pending approval as "skipped" so the loop unblocks.
    if (pendingApprovalRef.current) {
      pendingApprovalRef.current.resolve(false);
      pendingApprovalRef.current = null;
    }
  };

  const handleNew = () => {
    abortRef.current?.abort();
    setTranscript([]);
    setComposerText('');
    setRunning(false);
  };

  const handleExportPng = useCallback(async () => {
    if (!transcriptInnerRef.current) return;
    setExporting(true);
    try {
      const dataUrl = await exportAsPng({ element: transcriptInnerRef.current });
      setExportedPng(dataUrl);
    } catch {
      // silent — export failed
    } finally {
      setExporting(false);
    }
  }, []);

  const isEmpty = transcript.length === 0;

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <div className={s.title}>{title}</div>
          <div className={s.subtitle}>{subtitle}</div>
        </div>
        <div className={s.headerActions}>
          {!isEmpty && !running && (
            <>
              <button
                className={s.btn}
                onClick={() => void handleExportPng()}
                disabled={exporting}
                title="Save as PNG image"
              >
                {exporting ? 'Exporting...' : 'Export PNG'}
              </button>
            </>
          )}
          {running ? (
            <Button variant="secondary" size="sm" appearance="danger" onClick={handleStop}>
              Stop
            </Button>
          ) : (
            !isEmpty && (
              <Button variant="secondary" size="sm" onClick={handleNew}>
                New investigation
              </Button>
            )
          )}
        </div>
      </div>

      <div className={s.transcript} ref={transcriptRef}>
        <div className={s.transcriptInner} ref={transcriptInnerRef}>
          {isEmpty && !running ? (
            <EmptyState
              title={emptyStateTitle ?? title}
              hint={emptyStateHint}
              suggestions={emptyStateSuggestions}
              onPick={submitFreeForm}
            />
          ) : (
            <InvestigatorTranscript
              entries={transcript}
              renderToolCard={renderToolCard}
              running={running}
              onApprove={(id) => resolveApproval(id, true)}
              onSkip={(id) => resolveApproval(id, false)}
            />
          )}
        </div>
      </div>

      <div className={s.composer}>
        <div className={s.composerInner}>
          <textarea
            className={s.composerTextarea}
            placeholder="Ask me to investigate something..."
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
            onKeyDown={handleComposerKey}
            disabled={running}
            rows={1}
          />
          <button
            className={s.composerSend}
            onClick={() => submitFreeForm(composerText)}
            disabled={running || !composerText.trim()}
          >
            Send
          </button>
        </div>
      </div>

      <Modal
        isOpen={exportedPng !== null}
        onIsOpenChange={(open) => { if (!open) setExportedPng(null); }}
        title="Investigation snapshot"
        size="lg"
        footer={null}
      >
        <div className={s.exportHint}>
          Right-click the image → Save image as...
        </div>
        {exportedPng && (
          <img src={exportedPng} alt="Investigation export" className={s.exportImg} />
        )}
      </Modal>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────

function EmptyState({
  title,
  hint,
  suggestions,
  onPick,
}: {
  title: string;
  hint: string;
  suggestions: string[];
  onPick: (prompt: string) => void;
}) {
  return (
    <div className={s.emptyState}>
      <div className={s.emptyTitle}>{title}</div>
      <div className={s.emptyHint}>{hint}</div>
      {suggestions.length > 0 && (
        <div className={s.suggestions}>
          {suggestions.map((sg) => (
            <Button key={sg} variant="tertiary" size="sm" FORCE__className={s.suggestion} onClick={() => onPick(sg)}>
              {sg}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

