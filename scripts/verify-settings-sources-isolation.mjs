import 'dotenv/config';
import { query } from '@anthropic-ai/claude-agent-sdk';

const useIsolation = process.argv[2] === 'isolated';

console.log(`--- Running with settingSources ${useIsolation ? '= [] (isolated)' : 'OMITTED (current behavior)'} ---`);

const options = {
  cwd: '/tmp/approval-test',
  model: 'claude-sonnet-5',
  canUseTool: async (toolName, input) => {
    console.log(`>>> canUseTool CALLED for ${toolName}:`, JSON.stringify(input));
    return { behavior: 'deny', message: 'Denied by repro script for testing.' };
  },
};

if (useIsolation) {
  options.settingSources = [];
}

const stream = query({ prompt: 'Run: git push', options });

let sawCanUseToolCall = false;
const originalLog = console.log;
console.log = (...args) => {
  if (String(args[0]).includes('canUseTool CALLED')) sawCanUseToolCall = true;
  originalLog(...args);
};

for await (const message of stream) {
  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'text') process.stdout.write('[assistant] ' + block.text + '\n');
      if (block.type === 'tool_use') process.stdout.write('[tool_use] ' + block.name + ' ' + JSON.stringify(block.input) + '\n');
    }
  }
  if (message.type === 'result') {
    console.log('[result]', message.subtype, message.result?.slice?.(0, 200));
  }
}

console.log(`\n=== canUseTool was ${sawCanUseToolCall ? 'CALLED' : 'NEVER CALLED'} ===`);
