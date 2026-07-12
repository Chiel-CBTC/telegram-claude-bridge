import fs from 'node:fs';
import path from 'node:path';

export interface SessionStore {
  get(chatId: number): string | undefined;
  set(chatId: number, sessionId: string): void;
  reset(chatId: number): void;
}

interface SessionStoreData {
  [chatId: string]: string;
}

function loadFromDisk(filePath: string): SessionStoreData {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (raw.trim() === '') {
    return {};
  }
  return JSON.parse(raw) as SessionStoreData;
}

export function createSessionStore(filePath: string): SessionStore {
  const data: SessionStoreData = loadFromDisk(filePath);

  function persist(): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  return {
    get(chatId: number): string | undefined {
      return data[String(chatId)];
    },
    set(chatId: number, sessionId: string): void {
      data[String(chatId)] = sessionId;
      persist();
    },
    reset(chatId: number): void {
      delete data[String(chatId)];
      persist();
    },
  };
}
