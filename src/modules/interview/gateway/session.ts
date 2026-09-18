import type { WebSocket } from 'ws';
import { logger } from '@/common/logger';
import type { ClientMessage, ServerMessage } from '@/contracts/voice';
import { deepgramStt } from '@/modules/voice/deepgram.stt';
import { deepgramTts } from '@/modules/voice/deepgram.tts';
import { STT_SAMPLE_RATE, type SttStream, type TtsSession } from '@/modules/voice/types';
import { stateStore } from '@/modules/interview/state.store';
import { interviewRepository } from '@/modules/interview/interview.repository';
import { submitAnswer, ESTIMATED_TURN_SECONDS } from '@/modules/interview/engine/orchestrator';
import { prisma } from '@/db/prisma';
import type { PlanSection } from '@/modules/planner/schema';
import type { InterviewState } from '@/modules/interview/types';
import type { TicketPayload } from '@/modules/interview/gateway/ticket';

/** Loudest sample in a PCM16 frame — tells real speech apart from near-silence. */
function peakAmplitude(frame: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < frame.length; i += 2) {
    const v = Math.abs(frame.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak;
}

const MIN_TURN_SECONDS = 5;
const MAX_TURN_SECONDS = 300;

/**
 * Turn end is decided by Deepgram's `utterance_end_ms` alone (see deepgram.stt.ts).
 *
 * Do NOT add a second debounce on top of it. A previous version restarted a local
 * timer on every transcript; with a real microphone there is always faint room
 * noise, so stray interim results kept pushing the commit further out — the turn
 * either arrived seconds late or never fired at all. Deepgram's silence timer is
 * already the debounce; tune UTTERANCE_END_MS instead of layering on more.
 */

/**
 * One live voice interview over one WebSocket.
 *
 * Holds the Deepgram STT stream and TTS session open for the whole interview —
 * opening them costs 2-4s, speaking on an open one costs ~400ms.
 *
 * Half-duplex (PRD): while the interviewer is speaking we ignore mic audio, so
 * the AI can never hear itself.
 */
export class VoiceSession {
  private stt: SttStream | null = null;
  private tts: TtsSession | null = null;

  /** Final transcript fragments for the current turn. */
  private answerParts: string[] = [];
  private speaking = false;
  private muted = false;
  private busy = false;
  private closed = false;
  /** When the current question finished playing — used for a real turn duration. */
  private listeningSince = Date.now();
  private micFrames = 0;
  private droppedFrames = 0;
  private keyterms: string[] = [];
  private reconnecting = false;

  /** Blueprint bits needed to report progress; loaded once at start. */
  private sections: PlanSection[] = [];
  private durationMin = 0;
  private voice: string | undefined;

  /** Per-session logger so every line carries the interview id. */
  private readonly log;

  constructor(
    private readonly ws: WebSocket,
    private readonly ticket: TicketPayload,
  ) {
    this.log = logger.child({ interviewId: ticket.interviewId });
  }

  async start(): Promise<void> {
    const state = await stateStore.load(this.ticket.interviewId);
    if (!state) {
      this.send({ type: 'error', code: 'state_expired', message: 'This interview has expired.' });
      this.ws.close();
      return;
    }

    // Prime STT with the candidate's own tech terms so jargon survives transcription.
    const keyterms = await this.loadBlueprint();

    this.tts = await deepgramTts.openSession({ model: this.voice });
    this.keyterms = keyterms;
    await this.openStt();

    this.log.info(
      { voice: this.voice, keyterms: keyterms.length, pending: Boolean(state.pendingQuestion) },
      'voice session started',
    );
    this.sendState(state);

    // Speak whatever question is already pending (the interview was started over HTTP).
    if (state.pendingQuestion) {
      this.send({
        type: 'question',
        text: state.pendingQuestion,
        turnIdx: state.turnIdx,
        sectionKey: this.sectionKey(state),
      });
      await this.speak(state.pendingQuestion);
    }
  }

  /** Opens (or re-opens) the speech-to-text stream. */
  private async openStt(): Promise<void> {
    this.stt = await deepgramStt.openStream({
      sampleRate: STT_SAMPLE_RATE,
      keyterms: this.keyterms,
      onTranscript: ({ text, isFinal }) => {
        if (this.speaking) return; // ignore anything picked up while we talk
        this.send({ type: 'transcript', text, isFinal });
        if (isFinal) {
          this.answerParts.push(text);
          this.log.debug({ text: text.slice(0, 60) }, 'final transcript');
        }
      },
      onUtteranceEnd: () => this.onUtteranceEnd(),
      onError: (err) => this.log.error({ err }, 'STT stream error'),
      onClose: () => void this.reopenStt(),
    });
  }

  /**
   * Deepgram dropped the stream. Without this the interview silently dies: mic
   * frames keep arriving and get written to a closed socket, so no transcript
   * ever comes back and the candidate waits forever.
   */
  private async reopenStt(): Promise<void> {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    try {
      this.log.warn('STT stream closed — reconnecting');
      await this.openStt();
      this.log.info('STT stream reconnected');
    } catch (err) {
      this.log.error({ err }, 'STT reconnect failed');
      this.send({
        type: 'error',
        code: 'stt_lost',
        message: 'Lost the microphone stream. Please refresh.',
      });
    } finally {
      this.reconnecting = false;
    }
  }

  handleMessage(data: Buffer, isBinary: boolean): void {
    if (this.closed) return;

    if (isBinary) {
      // Half-duplex: drop mic audio while the interviewer is talking.
      if (this.speaking || this.muted || this.busy) {
        this.droppedFrames++;
        return;
      }
      if (this.stt && !this.stt.open) {
        void this.reopenStt();
        return;
      }
      this.micFrames++;
      // Periodic heartbeat: proves audio is still reaching STT during a silent hang.
      if (this.micFrames % 50 === 0) {
        this.log.debug(
          {
            micFrames: this.micFrames,
            dropped: this.droppedFrames,
            parts: this.answerParts.length,
            bytes: data.length,
            // 0-32767. Near zero means the worklet is shipping silence, so the
            // problem would be upstream of Deepgram entirely.
            peak: peakAmplitude(data),
          },
          'mic audio flowing',
        );
      }
      this.stt?.send(data);
      return;
    }

    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'mute':
        this.muted = true;
        break;
      case 'unmute':
        this.muted = false;
        break;
      case 'end':
        // Candidate pressed "End interview". Mark it ended, then hang up.
        // NOTE: only the explicit message does this — a plain socket close (wifi
        // blip, closed tab) must leave the row `live` so a refresh can resume it.
        void this.endEarly();
        break;
      case 'mic_info':
        this.log.info(
          { contextSampleRate: msg.contextSampleRate, targetSampleRate: msg.targetSampleRate },
          msg.contextSampleRate === msg.targetSampleRate
            ? 'mic ready'
            : 'mic ready (browser refused our rate — worklet is resampling)',
        );
        break;
      case 'text_answer':
        // Dev path: lets us exercise a full turn without a microphone.
        if (msg.text?.trim()) void this.finishTurn(msg.text.trim());
        break;
      default:
        break;
    }
  }

  /** Deepgram decided the candidate stopped talking — commit the turn. */
  private onUtteranceEnd(): void {
    if (this.busy || this.closed) return;
    const answer = this.answerParts.join(' ').trim();
    if (!answer) {
      this.log.debug('utteranceEnd with no transcript — still listening');
      return;
    }
    this.log.info({ ms: Date.now() - this.listeningSince }, 'turn committed');
    void this.finishTurn(answer);
  }

  private async finishTurn(answer: string): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    this.answerParts = [];

    try {
      this.send({ type: 'thinking' });
      const tStart = Date.now();

      const turnSeconds = Math.min(
        MAX_TURN_SECONDS,
        Math.max(MIN_TURN_SECONDS, Math.round((Date.now() - this.listeningSince) / 1000)),
      );

      const result = await submitAnswer(
        this.ticket.userId,
        this.ticket.interviewId,
        answer,
        turnSeconds || ESTIMATED_TURN_SECONDS,
      );

      const tEngine = Date.now() - tStart;

      if (result.done || !result.question) {
        this.send({ type: 'done' });
        this.close();
        return;
      }

      this.send({
        type: 'question',
        text: result.question,
        turnIdx: result.turnIdx,
        sectionKey: result.sectionKey,
      });
      await this.refreshState();
      const tSpeakStart = Date.now();
      const firstByteMs = await this.speak(result.question);
      this.log.info(
        {
          engineMs: tEngine,
          ttsFirstByteMs: firstByteMs,
          ttsTotalMs: Date.now() - tSpeakStart,
          totalMs: Date.now() - tStart,
          answerChars: answer.length,
        },
        'turn latency',
      );
    } catch (err) {
      logger.error({ err }, 'Voice turn failed');
      this.send({
        type: 'error',
        code: 'turn_failed',
        message: 'Something went wrong. Try again.',
      });
    } finally {
      this.busy = false;
    }
  }

  /**
   * Stream TTS audio to the browser, then hand the floor back to the candidate.
   * @returns ms until the first audio chunk went out (the number the user feels).
   */
  private async speak(text: string): Promise<number> {
    if (!this.tts || this.closed) return 0;
    this.speaking = true;
    const t0 = Date.now();
    let firstByteMs = 0;
    try {
      for await (const chunk of this.tts.speak(text)) {
        if (this.closed) break;
        if (!firstByteMs) firstByteMs = Date.now() - t0;
        this.ws.send(chunk, { binary: true });
      }
    } catch (err) {
      // TTS failed — the caption is already on screen, so the interview continues.
      logger.error({ err }, 'TTS failed; falling back to text-only for this turn');
      this.send({
        type: 'error',
        code: 'tts_failed',
        message: 'Audio unavailable for that question.',
      });
    } finally {
      this.speaking = false;
      this.answerParts = [];
      this.listeningSince = Date.now();
      this.send({ type: 'speech_end' });
    }
    return firstByteMs;
  }

  private async refreshState(): Promise<void> {
    const state = await stateStore.load(this.ticket.interviewId);
    if (state) this.sendState(state);
  }

  private sectionKey(state: InterviewState): string {
    return this.sections[state.sectionIdx]?.key ?? 'unknown';
  }

  private sendState(state: InterviewState): void {
    this.send({
      type: 'state',
      sectionKey: this.sectionKey(state),
      turnIdx: state.turnIdx,
      secondsLeft: Math.max(0, this.durationMin * 60 - state.totalElapsedSec),
    });
  }

  private send(msg: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /**
   * Loads the blueprint once (sections + duration for progress) and returns the
   * candidate's own skills, so Deepgram doesn't mangle their jargon.
   */
  private async loadBlueprint(): Promise<string[]> {
    const interview = await prisma.interview.findUnique({
      where: { id: this.ticket.interviewId },
      include: { blueprint: { include: { resume: true } } },
    });
    if (!interview) return [];
    this.sections = (interview.blueprint.sections as unknown as PlanSection[]) ?? [];
    this.durationMin = interview.blueprint.durationMin;
    this.voice = interview.blueprint.voice;
    const extracted = interview.blueprint.resume.extracted as { skills?: string[] } | null;
    return (extracted?.skills ?? []).slice(0, 50);
  }

  /** Stop the interview part-way through at the candidate's request. */
  private async endEarly(): Promise<void> {
    try {
      const ended = await interviewRepository.abandon(this.ticket.interviewId);
      await stateStore.clear(this.ticket.interviewId);
      if (ended) this.log.info('interview ended early by candidate');
    } catch (err) {
      this.log.error({ err }, 'failed to mark interview ended');
    } finally {
      this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stt?.close();
    this.tts?.close();
    if (this.ws.readyState === this.ws.OPEN) this.ws.close();
  }
}
