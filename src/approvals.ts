import crypto from 'node:crypto';

export interface ApprovalRequest {
  id: string;
  promise: Promise<boolean>;
}

export interface ApprovalBroker {
  request(chatId: number, description: string): ApprovalRequest;
  resolve(approvalId: string, approved: boolean): boolean;
}

interface PendingApproval {
  chatId: number;
  description: string;
  resolveFn: (approved: boolean) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export interface CreateApprovalBrokerOptions {
  timeoutMs: number;
  onTimeout?: (approvalId: string, chatId: number, description: string) => void;
}

export function createApprovalBroker(options: CreateApprovalBrokerOptions): ApprovalBroker {
  const pending = new Map<string, PendingApproval>();

  return {
    request(chatId: number, description: string): ApprovalRequest {
      const id = crypto.randomUUID();

      const promise = new Promise<boolean>((resolvePromise) => {
        const timeoutHandle = setTimeout(() => {
          const entry = pending.get(id);
          if (!entry) {
            return;
          }
          pending.delete(id);
          resolvePromise(false);
          options.onTimeout?.(id, chatId, entry.description);
        }, options.timeoutMs);

        pending.set(id, {
          chatId,
          description,
          resolveFn: resolvePromise,
          timeoutHandle,
        });
      });

      return { id, promise };
    },

    resolve(approvalId: string, approved: boolean): boolean {
      const entry = pending.get(approvalId);
      if (!entry) {
        return false;
      }
      pending.delete(approvalId);
      clearTimeout(entry.timeoutHandle);
      entry.resolveFn(approved);
      return true;
    },
  };
}
