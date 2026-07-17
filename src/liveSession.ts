import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export interface AsyncPushQueue<T> extends AsyncIterable<T> {
  push(item: T): void;
  close(): void;
}

class AsyncPushQueueImpl<T> implements AsyncPushQueue<T> {
  private readonly items: T[] = [];
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) {
      throw new Error('Cannot push to a closed AsyncPushQueue');
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift() as T, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiting.push(resolve);
        });
      },
    };
  }
}

export function createAsyncPushQueue<T>(): AsyncPushQueue<T> {
  return new AsyncPushQueueImpl<T>();
}

interface PendingTurn {
  resolve: (text: string) => void;
  reject: (err: unknown) => void;
}

export class TurnReader {
  private readonly pendingTurns: PendingTurn[] = [];
  private currentText = '';

  waitForNextTurn(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.pendingTurns.push({ resolve, reject });
    });
  }

  handleMessage(message: SDKMessage): void {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          this.currentText += block.text;
        }
      }
    }
    if (message.type === 'result') {
      const text = this.currentText;
      this.currentText = '';
      const turn = this.pendingTurns.shift();
      turn?.resolve(text);
    }
  }

  failNext(err: unknown): boolean {
    this.currentText = '';
    const turn = this.pendingTurns.shift();
    if (!turn) {
      return false;
    }
    turn.reject(err);
    return true;
  }

  failAll(err: unknown): void {
    this.currentText = '';
    while (this.pendingTurns.length > 0) {
      const turn = this.pendingTurns.shift();
      turn?.reject(err);
    }
  }

  hasPending(): boolean {
    return this.pendingTurns.length > 0;
  }
}

export class IdleCloser {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly timeoutMs: number,
    private readonly onIdle: () => void
  ) {}

  touch(): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onIdle();
    }, this.timeoutMs);
  }

  cancel(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
