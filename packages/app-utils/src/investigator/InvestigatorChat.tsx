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
 * Requires `@capra/core` (an optional peer dependency of this
 * package) for its Button and Modal components.
 */
import {
  useCallback,
  useEffect,
  useMemo,
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
  type AgentToolCall,
  type AgentToolDefinition,
} from '../agent.js';
import type {
  RunSearchUi,
  SummaryUi,
  ToolCallInvocation,
  ToolExecutionResult,
  ToolResultUi,
} from '../agent-tools.js';
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
// Transcript entry model
// ─────────────────────────────────────────────────────────────────

export interface InvestigatorUserEntry {
  kind: 'user';
  id: string;
  content: string;
}

export interface InvestigatorAssistantEntry {
  kind: 'assistant';
  id: string;
  turnId: string;
  content: string;
  inProgress: boolean;
}

export interface InvestigatorToolCallEntry {
  kind: 'toolCall';
  id: string;
  turnId: string;
  call: AgentToolCall;
  needsApproval: boolean;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'error';
  result?: ToolExecutionResult;
}

export interface InvestigatorErrorEntry {
  kind: 'error';
  id: string;
  message: string;
  /** True when this error is a session-expired from the platform's
   *  auth token. The UI shows a recovery explanation instead of
   *  just the raw message. */
  sessionExpired?: boolean;
}

export type InvestigatorTranscriptEntry =
  | InvestigatorUserEntry
  | InvestigatorAssistantEntry
  | InvestigatorToolCallEntry
  | InvestigatorErrorEntry;

// ─────────────────────────────────────────────────────────────────
// Minimal markdown rendering
// ─────────────────────────────────────────────────────────────────
//
// The assistant emits markdown-flavored text: inline code, fenced
// blocks, bold, and (frequently) GFM tables for diagnostic
// breakdowns. No need for a full markdown library — we handle the
// handful of things the agent actually uses and render everything
// else as paragraphs.

interface TableSpec {
  headers: string[];
  /** One of 'left' | 'right' | 'center' | undefined per column. */
  aligns: Array<'left' | 'right' | 'center' | undefined>;
  rows: string[][];
}

/**
 * Detect a GFM-style table at the start of `text` and return both
 * the parsed shape and the unconsumed remainder. Returns null when
 * the block doesn't match the GFM table shape (need at least a
 * header row + a separator row of dashes/colons).
 */
function tryParseTable(text: string): { table: TableSpec; rest: string } | null {
  const lines = text.split('\n');
  if (lines.length < 2) return null;
  const headerLine = lines[0].trim();
  const sepLine = lines[1].trim();
  if (!headerLine.includes('|') || !sepLine.includes('|')) return null;
  // The separator row distinguishes a table from a paragraph of
  // pipe-delimited prose. Cells are only `-`, `:`, and whitespace.
  const sepCells = splitTableRow(sepLine);
  if (sepCells.length === 0) return null;
  for (const cell of sepCells) {
    if (!/^:?-{1,}:?$/.test(cell.trim())) return null;
  }
  const headers = splitTableRow(headerLine);
  if (headers.length === 0) return null;
  const aligns: TableSpec['aligns'] = sepCells.map((c) => {
    const trimmed = c.trim();
    const left = trimmed.startsWith(':');
    const right = trimmed.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return undefined;
  });
  const rows: string[][] = [];
  let consumed = 2;
  for (let i = 2; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.trim().includes('|')) break;
    rows.push(splitTableRow(ln.trim()));
    consumed = i + 1;
  }
  const rest = lines.slice(consumed).join('\n');
  return { table: { headers, aligns, rows }, rest };
}

/**
 * Split a GFM table row on `|`, stripping the leading and trailing
 * pipe sentinels GFM allows. Each cell keeps its inline content
 * (whitespace gets trimmed at render time).
 */
function splitTableRow(line: string): string[] {
  let row = line;
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|');
}

function renderAssistantMarkdown(text: string): ReactNode[] {
  if (!text) return [];
  // Split on fenced code blocks first so we can preserve their
  // whitespace. Simple three-backtick fences only.
  const parts: Array<{ kind: 'text' | 'code'; body: string }> = [];
  const regex = /```(?:\w+)?\n?([\s\S]*?)```/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIdx) {
      parts.push({ kind: 'text', body: text.slice(lastIdx, m.index) });
    }
    parts.push({ kind: 'code', body: m[1] });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    parts.push({ kind: 'text', body: text.slice(lastIdx) });
  }

  const nodes: ReactNode[] = [];
  let nodeKey = 0;
  for (const part of parts) {
    if (part.kind === 'code') {
      nodes.push(<pre key={`pre-${nodeKey++}`}>{part.body}</pre>);
      continue;
    }
    // Split text into paragraphs by blank lines. Inside each para,
    // check for GFM tables first (they're contiguous pipe-delimited
    // lines with a `|---|---|` separator) and fall through to
    // inline-rendered paragraphs otherwise.
    const paras = part.body.split(/\n{2,}/);
    for (const para of paras) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      const parsed = tryParseTable(trimmed);
      if (parsed) {
        nodes.push(
          <table key={`tbl-${nodeKey++}`} className={s.assistantTable}>
            <thead>
              <tr>
                {parsed.table.headers.map((h, i) => (
                  <th
                    key={i}
                    style={
                      parsed.table.aligns[i]
                        ? { textAlign: parsed.table.aligns[i] }
                        : undefined
                    }
                  >
                    {renderInline(h.trim())}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {parsed.table.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td
                      key={c}
                      style={
                        parsed.table.aligns[c]
                          ? { textAlign: parsed.table.aligns[c] }
                          : undefined
                      }
                    >
                      {renderInline(cell.trim())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>,
        );
        // tryParseTable returns the unconsumed remainder for tables
        // that share a paragraph with trailing prose — render that
        // as a follow-on paragraph so nothing gets dropped.
        const rest = parsed.rest.trim();
        if (rest) {
          nodes.push(<p key={`p-${nodeKey++}`}>{renderInline(rest)}</p>);
        }
        continue;
      }
      nodes.push(<p key={`p-${nodeKey++}`}>{renderInline(trimmed)}</p>);
    }
  }
  return nodes;
}

function renderInline(text: string): ReactNode[] {
  // Inline code spans and bold spans only — interleaved by
  // scanning left-to-right and splitting on the nearest token.
  const out: ReactNode[] = [];
  let key = 0;
  let rest = text;
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/;
  while (rest.length > 0) {
    const idx = rest.search(pattern);
    if (idx === -1) {
      out.push(rest);
      break;
    }
    if (idx > 0) out.push(rest.slice(0, idx));
    const match = rest.slice(idx).match(pattern)![0];
    if (match.startsWith('`')) {
      out.push(<code key={`c-${key++}`}>{match.slice(1, -1)}</code>);
    } else {
      out.push(<strong key={`b-${key++}`}>{match.slice(2, -2)}</strong>);
    }
    rest = rest.slice(idx + match.length);
  }
  return out;
}

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
            transcript.map((entry) => (
              <TranscriptRow
                key={entry.id}
                entry={entry}
                renderToolCard={renderToolCard}
                onApprove={(id) => resolveApproval(id, true)}
                onSkip={(id) => resolveApproval(id, false)}
              />
            ))
          )}
          {running && <ThinkingIndicator />}
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

function ThinkingIndicator() {
  return (
    <div className={s.thinking}>
      <div className={s.thinkingDots}>
        <span className={s.thinkingDot} />
        <span className={s.thinkingDot} />
        <span className={s.thinkingDot} />
      </div>
      Thinking…
    </div>
  );
}

function TranscriptRow({
  entry,
  renderToolCard,
  onApprove,
  onSkip,
}: {
  entry: InvestigatorTranscriptEntry;
  renderToolCard?: (ui: ToolResultUi, ctx: { entry: unknown }) => ReactNode | null;
  onApprove: (callId: string) => void;
  onSkip: (callId: string) => void;
}) {
  if (entry.kind === 'user') {
    return <div className={s.userMessage}>{entry.content}</div>;
  }
  if (entry.kind === 'assistant') {
    return (
      <div className={s.assistantMessage}>
        <div className={s.assistantIcon}>AI</div>
        <div className={s.assistantBody}>
          {renderAssistantMarkdown(entry.content)}
        </div>
      </div>
    );
  }
  if (entry.kind === 'error') {
    if (entry.sessionExpired) {
      return (
        <div className={s.errorBanner} role="alert">
          <div className={s.errorBannerTitle}>
            Cribl AI bearer token cache is in a broken state
          </div>
          <div className={s.errorBannerBody}>
            <p>
              The Cribl AI subsystem returned{' '}
              <code>Bearer Token has expired</code>. This is a
              platform-side problem with the per-user AI token cache,
              <em>not</em> your Cribl session — other Cribl API calls
              are still working.
            </p>
            <p>
              <strong>Reloading this page will not help.</strong> The
              same failure reproduces in Cribl Search&apos;s own
              native <code>/search/agent</code> Copilot UI on this
              workspace, so client-side retries can&apos;t recover.
              Known mitigations:
            </p>
            <ul>
              <li>Fully log out of Cribl Cloud and log back in.</li>
              <li>
                Wait for the server-side cache to TTL out and try
                again.
              </li>
              <li>Contact Cribl support if the problem persists.</li>
            </ul>
          </div>
        </div>
      );
    }
    return <div className={s.errorBanner}>Error: {entry.message}</div>;
  }
  // toolCall
  return (
    <ToolCallCard
      entry={entry}
      renderToolCard={renderToolCard}
      onApprove={() => onApprove(entry.call.id)}
      onSkip={() => onSkip(entry.call.id)}
    />
  );
}

function ToolCallCard({
  entry,
  renderToolCard,
  onApprove,
  onSkip,
}: {
  entry: InvestigatorToolCallEntry;
  renderToolCard?: (ui: ToolResultUi, ctx: { entry: unknown }) => ReactNode | null;
  onApprove: () => void;
  onSkip: () => void;
}) {
  const name = entry.call.function.name;
  const ui = entry.result?.ui;

  // App-supplied cards get first crack at any result UI; a nullish
  // return falls through to the built-ins.
  if (renderToolCard && ui) {
    const custom = renderToolCard(ui, { entry });
    if (custom !== null && custom !== undefined) {
      return <>{custom}</>;
    }
  }

  if (name === 'run_search') {
    return (
      <SearchCard
        entry={entry}
        onApprove={onApprove}
        onSkip={onSkip}
        ui={ui?.kind === 'search' ? (ui as RunSearchUi) : undefined}
      />
    );
  }
  if (name === 'present_investigation_summary') {
    return <SummaryCard ui={ui?.kind === 'summary' ? (ui as SummaryUi) : undefined} />;
  }
  // update_context and friends are agent plumbing — don't clutter the
  // transcript with them. App-specific kinds render only once their
  // result arrives (via renderToolCard above).
  return null;
}

function SearchCard({
  entry,
  onApprove,
  onSkip,
  ui,
}: {
  entry: InvestigatorToolCallEntry;
  onApprove: () => void;
  onSkip: () => void;
  ui?: RunSearchUi;
}) {
  const args = parseRunSearchArgs(entry.call.function.arguments);
  return (
    <div className={s.toolCall}>
      <div className={s.toolCallHeader}>
        <div>
          <div className={s.toolCallDescription}>
            {args.description || 'Run search'}
          </div>
          <div className={s.toolCallMeta}>
            {args.earliest ?? '-15m'} to {args.latest ?? 'now'}
            {ui && ` · ${ui.rowCount} rows · ${ui.durationMs}ms`}
          </div>
        </div>
        {entry.status === 'pending' && entry.needsApproval && (
          <div className={s.toolCallActions}>
            <Button variant="secondary" size="sm" appearance="danger" onClick={onSkip}>
              Skip
            </Button>
            <Button variant="primary" size="sm" onClick={onApprove}>
              Run Query
            </Button>
          </div>
        )}
      </div>
      <pre className={s.toolCallQuery}>{args.query ?? '(no query)'}</pre>
      {ui?.error && <div className={s.toolResultError}>{ui.error}</div>}
      {ui && !ui.error && ui.rows.length > 0 && <ResultTable ui={ui} />}
      {ui && !ui.error && ui.rows.length === 0 && (
        <div className={s.toolResultMeta}>No results</div>
      )}
    </div>
  );
}

function SummaryCard({ ui }: { ui?: SummaryUi }) {
  if (!ui) {
    return (
      <div className={s.summaryCard}>
        <div className={s.summaryTitle}>📋 Investigation summary</div>
        <div className={s.toolResultMeta}>Preparing…</div>
      </div>
    );
  }
  return (
    <div className={s.summaryCard}>
      <div className={s.summaryTitle}>📋 Investigation summary</div>
      {ui.findings.length > 0 && (
        <div className={s.summaryFindings}>
          {ui.findings.map((f, i) => (
            <div key={i} className={s.summaryFinding}>
              <div className={s.summaryCategory}>{f.category}</div>
              <div className={s.summaryDetails}>
                {renderAssistantMarkdown(f.details)}
              </div>
            </div>
          ))}
        </div>
      )}
      {ui.conclusion && (
        <div className={s.summaryConclusion}>
          <div className={s.summaryConclusionLabel}>Conclusion</div>
          <div>{renderAssistantMarkdown(ui.conclusion)}</div>
        </div>
      )}
    </div>
  );
}

function ResultTable({ ui }: { ui: RunSearchUi }) {
  const { cols, rows } = useMemo(() => {
    const capped = ui.rows.slice(0, 20);
    const keyCounts = new Map<string, number>();
    for (const r of capped) {
      for (const k of Object.keys(r)) keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
    }
    const cols = Array.from(keyCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k]) => k)
      .slice(0, 8);
    return { cols, rows: capped };
  }, [ui.rows]);

  return (
    <div className={s.toolResult}>
      <table className={s.toolResultTable}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>{formatCell(row[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {ui.rowCount > 20 && (
        <div className={s.toolResultMeta}>
          … {ui.rowCount - 20} more row{ui.rowCount - 20 === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function parseRunSearchArgs(raw: string): {
  query?: string;
  earliest?: string;
  latest?: string;
  description?: string;
} {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────
// Reducer — apply a LoopEvent to the transcript array
// ─────────────────────────────────────────────────────────────────

export function applyLoopEvent(
  prev: InvestigatorTranscriptEntry[],
  ev: LoopEvent,
): InvestigatorTranscriptEntry[] {
  switch (ev.kind) {
    case 'assistantText': {
      // Find the most recent in-progress assistant entry for this
      // turn; append to it, or create one if missing.
      const lastIdx = findLastAssistant(prev, ev.turnId);
      if (lastIdx !== -1) {
        const next = prev.slice();
        const entry = next[lastIdx] as InvestigatorAssistantEntry;
        next[lastIdx] = { ...entry, content: entry.content + ev.chunk };
        return next;
      }
      return [
        ...prev,
        {
          kind: 'assistant',
          id: `a-${ev.turnId}`,
          turnId: ev.turnId,
          content: ev.chunk,
          inProgress: true,
        },
      ];
    }
    case 'assistantDone': {
      const lastIdx = findLastAssistant(prev, ev.turnId);
      if (lastIdx === -1) return prev;
      const next = prev.slice();
      const entry = next[lastIdx] as InvestigatorAssistantEntry;

      // If a SummaryCard was already rendered in this transcript
      // (from a real tool call), the agent sometimes ALSO writes a
      // redundant markdown dump starting with "## Findings". Drop
      // the entire assistant message in that case — the card is
      // the canonical rendering.
      const hasRenderedSummary = next.some(
        (e) =>
          e.kind === 'toolCall' &&
          e.call.function.name === 'present_investigation_summary' &&
          e.result?.ui?.kind === 'summary',
      );
      const looksLikeRedundantSummary =
        hasRenderedSummary &&
        /^\s*##\s*(Findings|Conclusion)\b/m.test(entry.content);
      if (looksLikeRedundantSummary) {
        next.splice(lastIdx, 1);
        return next;
      }

      // Scrub any {% present_investigation_summary {...} %} text the
      // agent may have written instead of calling the tool. If we
      // find any, split the assistant entry into cleaned text +
      // synthetic summary entries that render via SummaryCard.
      const { cleaned, summaries } = scrubTemplateSummaries(entry.content);
      if (summaries.length === 0) {
        next[lastIdx] = { ...entry, inProgress: false };
        return next;
      }
      const insertions: InvestigatorTranscriptEntry[] = [];
      // Replace the assistant entry with the cleaned version (if any
      // text remains) and append a synthetic toolCall entry per
      // parsed summary. Use a nanoid-ish key so React keeps stable.
      next[lastIdx] = { ...entry, inProgress: false, content: cleaned };
      // If the cleaned content is now empty, drop the assistant entry.
      if (!cleaned.trim()) {
        next.splice(lastIdx, 1);
      }
      for (let i = 0; i < summaries.length; i++) {
        const synthId = `synthetic-summary-${ev.turnId}-${i}`;
        insertions.push({
          kind: 'toolCall',
          id: synthId,
          turnId: ev.turnId,
          call: {
            id: synthId,
            function: {
              name: 'present_investigation_summary',
              arguments: JSON.stringify(summaries[i]),
            },
          },
          needsApproval: false,
          status: 'done',
          result: {
            id: synthId,
            name: 'present_investigation_summary',
            content: '',
            ui: summaries[i],
          },
        });
      }
      return [...next, ...insertions];
    }
    case 'toolCall': {
      return [
        ...prev,
        {
          kind: 'toolCall',
          id: `tc-${ev.call.id}`,
          turnId: ev.turnId,
          call: ev.call,
          needsApproval: ev.needsApproval,
          status: ev.needsApproval ? 'pending' : 'running',
        },
      ];
    }
    case 'toolResult': {
      return prev.map((e) => {
        if (e.kind !== 'toolCall' || e.call.id !== ev.result.id) return e;
        const ui = ev.result.ui;
        // Any card kind can carry an `error` field (search, trace,
        // …) — mark the entry errored so the card styles it.
        const uiError = ui?.error;
        const hasError = typeof uiError === 'string' && uiError.length > 0;
        return { ...e, status: hasError ? 'error' : 'done', result: ev.result };
      });
    }
    case 'notification':
    case 'done':
      return prev;
    case 'error':
      return [
        ...prev,
        {
          kind: 'error',
          id: `err-${Date.now()}`,
          message: ev.error.message,
          sessionExpired: isSessionExpiredError(ev.error),
        },
      ];
  }
}

function findLastAssistant(
  entries: InvestigatorTranscriptEntry[],
  turnId: string,
): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === 'assistant' && e.turnId === turnId) return i;
  }
  return -1;
}

/**
 * Scrub any occurrences of `{% present_investigation_summary {...} %}`
 * text that the agent sometimes emits as plain text instead of
 * calling the tool properly. Returns the cleaned text (for the
 * assistant bubble) and an array of parsed summaries (to render as
 * Summary cards inline).
 *
 * This is a belt-and-suspenders fallback: seed prompts instruct the
 * agent to CALL the tool, but LLMs occasionally improvise this
 * template-literal format, and we don't want the user to see raw
 * JSON dumps in a pretty chat UI.
 */
function scrubTemplateSummaries(text: string): {
  cleaned: string;
  summaries: SummaryUi[];
} {
  const summaries: SummaryUi[] = [];
  // Two flavors seen in the wild:
  //   {% present_investigation_summary {...} %}
  //   {% present_investigation_summary("findings":[...]) %}
  // Match the tool name, then a balanced JSON object up to `%}`.
  const regex = /\{%\s*present_investigation_summary\s+(\{[\s\S]*?\})\s*%\}/g;
  let cleaned = text;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      const findings: Array<{ category: string; details: string }> = [];
      if (Array.isArray(obj.findings)) {
        for (const f of obj.findings) {
          findings.push({
            category: typeof f.category === 'string' ? f.category : 'Finding',
            details: typeof f.details === 'string' ? f.details : '',
          });
        }
      }
      summaries.push({
        kind: 'summary',
        findings,
        conclusion: typeof obj.conclusion === 'string' ? obj.conclusion : '',
      });
      cleaned = cleaned.replace(m[0], '').trim();
    } catch {
      /* leave the raw template in place if parsing fails */
    }
  }
  return { cleaned, summaries };
}
