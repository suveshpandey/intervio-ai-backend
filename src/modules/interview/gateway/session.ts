import type { WebSocket } from 'ws';
import { logger } from '@/common/logger';
import type { ClientMessage, ServerMessage } from '@/contracts/voice';
import { deepgramStt } from '@/modules/voice/deepgram.stt';
import { deepgramTts } from '@/modules/voice/deepgram.tts';
import { STT_SAMPLE_RATE, type SttStream, type TtsSession } from '@/modules/voice/types';
import { stateStore } from '@/modules/interview/state.store';
import { submitAnswer, ESTIMATED_TURN_SECONDS } from '@/modules/interview/engine/orchestrator';
import { prisma } from '@/db/prisma';
import type { PlanSection } from '@/modules/planner/schema';
import type { InterviewState } from '@/modules/interview/types';
import type { TicketPayload } from '@/modules/interview/gateway/ticket';

const MIN_TURN_SECONDS = 5;
const MAX_TURN_SECONDS = 300;

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

  /** Blueprint bits needed to report progress; loaded once at start. */
  private sections: PlanSection[] = [];
  private durationMin = 0;

  constructor(
    private readonly ws: WebSocket,
    private readonly ticket: TicketPayload,
  ) {}

  async start(): Promise<void> {
    const state = await stateStore.load(this.ticket.interviewId);
    if (!state) {
      this.send({ type: 'error', code: 'state_expired', message: 'This interview has expired.' });
      this.ws.close();
      return;
    }

    // Prime STT with the candidate's own tech terms so jargon survives transcription.
    const keyterms = await this.loadBlueprint();

    this.tts = await deepgramTts.openSession();
    this.stt = await deepgramStt.openStream({
      sampleRate: STT_SAMPLE_RATE,
      keyterms,
      onTranscript: ({ text, isFinal }) => {
        if (this.speaking) return; // ignore anything picked up while we talk
        this.send({ type: 'transcript', text, isFinal });
        if (isFinal) this.answerParts.push(text);
      },
      onUtteranceEnd: () => void this.onUtteranceEnd(),
      onError: (err) => logger.error({ err }, 'STT stream error'),
    });

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

  handleMessage(data: Buffer, isBinary: boolean): void {
    if (this.closed) return;

    if (isBinary) {
      // Half-duplex: drop mic audio while the interviewer is talking.
      if (this.speaking || this.muted || this.busy) return;
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
        this.close();
        break;
      case 'text_answer':
        // Dev path: lets us exercise a full turn without a microphone.
        if (msg.text?.trim()) void this.finishTurn(msg.text.trim());
        break;
      default:
        break;
    }
  }

  /** Deepgram says the candidate stopped talking — take what we have. */
  private async onUtteranceEnd(): Promise<void> {
    const answer = this.answerParts.join(' ').trim();
    if (!answer) return;
    await this.finishTurn(answer);
  }

  private async finishTurn(answer: string): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    this.answerParts = [];

    try {
      this.send({ type: 'thinking' });

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
      await this.speak(result.question);
    } catch (err) {
      logger.error({ err }, 'Voice turn failed');
      this.send({ type: 'error', code: 'turn_failed', message: 'Something went wrong. Try again.' });
    } finally {
      this.busy = false;
    }
  }

  /** Stream TTS audio to the browser, then hand the floor back to the candidate. */
  private async speak(text: string): Promise<void> {
    if (!this.tts || this.closed) return;
    this.speaking = true;
    try {
      for await (const chunk of this.tts.speak(text)) {
        if (this.closed) break;
        this.ws.send(chunk, { binary: true });
      }
    } catch (err) {
      // TTS failed — the caption is already on screen, so the interview continues.
      logger.error({ err }, 'TTS failed; falling back to text-only for this turn');
      this.send({ type: 'error', code: 'tts_failed', message: 'Audio unavailable for that question.' });
    } finally {
      this.speaking = false;
      this.answerParts = [];
      this.listeningSince = Date.now();
      this.send({ type: 'speech_end' });
    }
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
    const extracted = interview.blueprint.resume.extracted as { skills?: string[] } | null;
    return (extracted?.skills ?? []).slice(0, 50);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stt?.close();
    this.tts?.close();
    if (this.ws.readyState === this.ws.OPEN) this.ws.close();
  }
}
