/**
 * T3-board: ask 等待期即时结算 (instant settle during the ask foreground wait).
 *
 * Spike conclusion (host @deepseek-ai/dsh-user-questions 0.2.2-alpha.2, read
 * only): attachWait streams exactly one {remainingMs} frame — the answer is
 * NEVER delivered on the stream. Settlement goes through the
 * 'user-questions/request' waterfall: a listener that returns { answers }
 * vetoes the innermost noAnswerer and its value becomes askTimed's return
 * (the Web client settles through the same waterfall). Holding the attachWait
 * stream adds a claim to TimedQuestionWait.claims, which suppresses the
 * host's deadline timer while the claim lives; releasing it re-arms the timer
 * (an expired wait then closes with ASK_TIMED_OUT → the pending path).
 *
 * Fail-open contract: when the attach yields no frame (wait already gone,
 * expired, or aborted) or the attach throws, holdForegroundWait returns
 * undefined and the caller proceeds WITHOUT a claim: its waterfall listener
 * stays armed and can still settle instantly from QQ, but the host deadline
 * timer keeps running — the wait stays bounded by the host budget, and once
 * it expires the request falls through (next()) to NO_PROVIDER, which
 * askTimed maps to pending (the existing 300s→pending→inbound answer()
 * path). Fallback guarantee: if the host ever drops attachWait, settlement
 * degrades to this bounded-instant + pending behaviour instead of breaking.
 * @module dsh-onebot/ask-foreground
 */

/** The waterfall request the host dispatches for a timed ask (index.js ask()). */
export interface ForegroundQuestionRequest {
  questions?: unknown
  agent?: unknown
  signal?: AbortSignal
  wait?: { callId?: string; timed?: boolean }
}

/** The attachWait slice of the host userQuestions service (Remote stream). */
export interface AttachWaitPort {
  attachWait(agent: unknown, callId: string, signal: AbortSignal): AsyncIterableIterator<{ remainingMs?: number }>
}

export interface ForegroundHold {
  /** Host budget left at attach time (ms); the holder must not wait longer. */
  remainingMs: number
  /** Release the claim (abort our signal); the host deadline timer resumes. */
  release(): void
  /** Resolves when the claim stream ends (the wait was closed host-side). */
  ended: Promise<void>
}

/**
 * Attach to the host's foreground wait stream (one claim among many — the
 * claims set never rejects a second holder). Returns undefined when the wait
 * is unavailable (zero frames: already settled / expired / aborted) or the
 * attach fails — both mean "do not hold, fall back to the existing path".
 */
export async function holdForegroundWait(
  service: AttachWaitPort,
  agent: unknown,
  callId: string,
  requestSignal: AbortSignal | undefined,
): Promise<ForegroundHold | undefined> {
  if (requestSignal === undefined || requestSignal.aborted) return undefined
  const claim = new AbortController()
  try {
    const stream = service.attachWait(agent, callId, claim.signal)
    const opening = await stream.next()
    if (opening.done === true) {
      claim.abort()
      return undefined
    }
    const remainingMs = (opening.value as { remainingMs?: number }).remainingMs
    if (typeof remainingMs !== 'number' || !(remainingMs > 0)) {
      claim.abort()
      return undefined
    }
    // Keep the claim stream alive: the second next() resolves only when the
    // host closes the wait (tool finished / aborted / deadline with no claim).
    const ended = stream.next().then(() => undefined, () => undefined)
    return { remainingMs, release: () => claim.abort(), ended }
  } catch {
    claim.abort()
    return undefined
  }
}
