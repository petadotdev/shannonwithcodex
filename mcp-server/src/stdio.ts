import { createSaveDeliverableHandler, SAVE_DELIVERABLE_DESCRIPTION, SAVE_DELIVERABLE_NAME, SaveDeliverableJsonSchema, type SaveDeliverableInput } from './tools/save-deliverable.js';
import { generateTotp, GENERATE_TOTP_DESCRIPTION, GENERATE_TOTP_NAME, GenerateTotpJsonSchema, type GenerateTotpInput } from './tools/generate-totp.js';
import type { ToolResult } from './types/tool-responses.js';

type JsonRpcId = number | string | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

function getTargetDir(): string {
  const args = process.argv.slice(2);
  const targetDirIndex = args.indexOf('--target-dir');

  if (targetDirIndex === -1 || !args[targetDirIndex + 1]) {
    throw new Error('Missing required --target-dir argument');
  }

  return args[targetDirIndex + 1]!;
}

function writeMessage(message: JsonRpcResponse): void {
  const payload = JSON.stringify(message);
  const header = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n`;
  process.stdout.write(header + payload);
}

function writeResult(id: JsonRpcId, result: unknown): void {
  writeMessage({
    jsonrpc: '2.0',
    id,
    result,
  });
}

function writeError(id: JsonRpcId, code: number, message: string): void {
  writeMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  });
}

function createToolRegistry(targetDir: string): Map<string, ToolDefinition> {
  const saveDeliverable = createSaveDeliverableHandler(targetDir);

  return new Map<string, ToolDefinition>([
    [
      SAVE_DELIVERABLE_NAME,
      {
        name: SAVE_DELIVERABLE_NAME,
        description: SAVE_DELIVERABLE_DESCRIPTION,
        inputSchema: SaveDeliverableJsonSchema,
        handler: (args) => saveDeliverable(args as SaveDeliverableInput),
      },
    ],
    [
      GENERATE_TOTP_NAME,
      {
        name: GENERATE_TOTP_NAME,
        description: GENERATE_TOTP_DESCRIPTION,
        inputSchema: GenerateTotpJsonSchema,
        handler: (args) => generateTotp(args as GenerateTotpInput),
      },
    ],
  ]);
}

async function handleRequest(request: JsonRpcRequest, tools: Map<string, ToolDefinition>): Promise<void> {
  if (!('id' in request) || request.id === undefined) {
    return;
  }

  switch (request.method) {
    case 'initialize': {
      const requestedProtocolVersion = request.params?.protocolVersion;
      const protocolVersion = typeof requestedProtocolVersion === 'string'
        ? requestedProtocolVersion
        : '2024-11-05';

      writeResult(request.id, {
        protocolVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'shannon-helper',
          version: '1.0.0',
        },
      });
      return;
    }

    case 'ping':
      writeResult(request.id, {});
      return;

    case 'tools/list':
      writeResult(request.id, {
        tools: Array.from(tools.values()).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
      return;

    case 'tools/call': {
      const toolName = request.params?.name;
      if (typeof toolName !== 'string') {
        writeError(request.id, -32602, 'Missing required string param: name');
        return;
      }

      const tool = tools.get(toolName);
      if (!tool) {
        writeError(request.id, -32601, `Unknown tool: ${toolName}`);
        return;
      }

      const args = request.params?.arguments;
      if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
        writeError(request.id, -32602, 'Tool arguments must be an object');
        return;
      }

      const result = await tool.handler((args as Record<string, unknown>) || {});
      writeResult(request.id, result);
      return;
    }

    default:
      writeError(request.id, -32601, `Method not found: ${request.method}`);
  }
}

async function main(): Promise<void> {
  const targetDir = getTargetDir();
  const tools = createToolRegistry(targetDir);
  let buffer = Buffer.alloc(0);

  process.stdin.on('data', async (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }

      const headerText = buffer.subarray(0, headerEnd).toString('utf8');
      const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        buffer = Buffer.alloc(0);
        return;
      }

      const contentLengthValue = lengthMatch[1];
      if (!contentLengthValue) {
        buffer = Buffer.alloc(0);
        return;
      }

      const contentLength = Number(contentLengthValue);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      if (buffer.length < bodyEnd) {
        return;
      }

      const body = buffer.subarray(bodyStart, bodyEnd).toString('utf8');
      buffer = buffer.subarray(bodyEnd);

      try {
        const request = JSON.parse(body) as JsonRpcRequest;

        if (request.method === 'notifications/initialized') {
          continue;
        }

        await handleRequest(request, tools);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeError(null, -32700, message);
      }
    }
  });

  process.stdin.resume();
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
