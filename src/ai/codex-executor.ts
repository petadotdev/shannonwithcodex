import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { matchesBillingApiPattern, matchesBillingTextPattern } from '../utils/billing-detection.js';
import { Timer } from '../utils/metrics.js';
import { AGENTS, MCP_AGENT_MAPPING } from '../session-manager.js';
import type { AgentName } from '../types/index.js';
import type { AuditSession } from '../audit/index.js';
import type { ActivityLogger } from '../types/activity-logger.js';

import { createAuditLogger } from './audit-logger.js';
import {
  detectExecutionContext,
  formatAssistantOutput,
  formatCompletionMessage,
  formatErrorOutput,
  formatToolResultOutput,
  formatToolUseOutput,
} from './output-formatters.js';
import { createProgressManager } from './progress-manager.js';
import { createTemporaryCodexHome, pathExists } from './codex-home.js';
import { resolveCodexModel, type ModelTier } from './models.js';
import type { AgentPromptResult } from './prompt-result.js';

declare global {
  var SHANNON_DISABLE_LOADER: boolean | undefined;
}

interface CodexEventItem {
  type?: string;
  text?: string;
  title?: string;
  command?: string;
  status?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  output?: string;
  result?: unknown;
  exit_code?: number;
}

interface CodexEvent {
  type: string;
  item?: CodexEventItem;
  error?: {
    message?: string;
  };
  usage?: {
    output_tokens?: number;
  };
}

function outputLines(lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function tomlTable(entries: Record<string, string>): string {
  return `{ ${Object.entries(entries).map(([key, value]) => `${key} = ${tomlString(value)}`).join(', ')} }`;
}

function buildPlaywrightConfig(agentName: AgentName | null, logger: ActivityLogger): string {
  if (!agentName) {
    return '';
  }

  const promptTemplate = AGENTS[agentName].promptTemplate;
  const playwrightMcpName = MCP_AGENT_MAPPING[promptTemplate as keyof typeof MCP_AGENT_MAPPING] || null;
  if (!playwrightMcpName) {
    return '';
  }

  logger.info(`Assigned ${agentName} -> ${playwrightMcpName}`);

  const args = [
    '-y',
    '@playwright/mcp@latest',
    '--isolated',
    '--user-data-dir',
    `/tmp/${playwrightMcpName}`,
    '--executable-path',
    '/usr/bin/chromium-browser',
    '--browser',
    'chromium',
  ];

  return `
[mcp_servers.${playwrightMcpName}]
command = "npx"
args = ${tomlArray(args)}
env = ${tomlTable({
    PLAYWRIGHT_HEADLESS: 'true',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  })}
required = true
startup_timeout_sec = 30
tool_timeout_sec = 180
`;
}

function buildCodexConfig(sourceDir: string, agentName: AgentName | null, logger: ActivityLogger): string {
  return [
    'file_opener = "none"',
    '',
    '[mcp_servers.shannon-helper]',
    'command = "node"',
    `args = ${tomlArray(['/app/mcp-server/dist/stdio.js', '--target-dir', sourceDir])}`,
    'required = true',
    'startup_timeout_sec = 15',
    'tool_timeout_sec = 120',
    buildPlaywrightConfig(agentName, logger).trim(),
    '',
  ].filter(Boolean).join('\n');
}

async function prepareCodexHome(
  sourceDir: string,
  agentName: AgentName | null,
  logger: ActivityLogger
): Promise<{ codexHome: string; cleanup: () => Promise<void> }> {
  return createTemporaryCodexHome(buildCodexConfig(sourceDir, agentName, logger));
}

function isRetryableCodexError(message: string): boolean {
  const lowerMessage = message.toLowerCase();

  if (
    lowerMessage.includes('401')
    || lowerMessage.includes('authentication')
    || lowerMessage.includes('login')
    || lowerMessage.includes('not logged in')
    || lowerMessage.includes('api key')
  ) {
    return false;
  }

  if (
    lowerMessage.includes('rate limit')
    || lowerMessage.includes('temporarily unavailable')
    || lowerMessage.includes('timed out')
    || matchesBillingApiPattern(message)
    || matchesBillingTextPattern(message)
  ) {
    return true;
  }

  return true;
}

function getToolName(item: CodexEventItem): string {
  return item.name || item.title || item.type || 'codex-tool';
}

async function handleCodexEvent(
  event: CodexEvent,
  turnCount: number,
  description: string,
  logger: ActivityLogger,
  auditLogger: ReturnType<typeof createAuditLogger>,
  execContext: ReturnType<typeof detectExecutionContext>,
  progress: ReturnType<typeof createProgressManager>
): Promise<void> {
  switch (event.type) {
    case 'item.completed': {
      const item = event.item;
      if (!item) {
        return;
      }

      if (item.type === 'agent_message' && item.text) {
        progress.stop();
        outputLines(formatAssistantOutput(item.text, execContext, turnCount, description));
        progress.start();
        await auditLogger.logLlmResponse(turnCount, item.text);
        return;
      }

      if (item.type === 'mcp_tool_call' || item.type === 'tool_call') {
        outputLines(formatToolResultOutput(JSON.stringify(item.result ?? {}, null, 2)));
        await auditLogger.logToolEnd(item.result);
        return;
      }

      if (item.type === 'command_execution' && item.output) {
        logger.info(`Command output: ${item.output.slice(0, 500)}`);
      }
      return;
    }

    case 'item.started': {
      const item = event.item;
      if (!item) {
        return;
      }

      if (item.type === 'mcp_tool_call' || item.type === 'tool_call') {
        outputLines(formatToolUseOutput(getToolName(item), item.arguments));
        await auditLogger.logToolStart(getToolName(item), item.arguments ?? {});
      }
      return;
    }

    default:
      return;
  }
}

export async function runCodexPrompt(
  prompt: string,
  sourceDir: string,
  context: string = '',
  description: string = 'Codex analysis',
  agentName: AgentName | null = null,
  auditSession: AuditSession | null = null,
  logger: ActivityLogger,
  modelTier: ModelTier = 'medium'
): Promise<AgentPromptResult> {
  const timer = new Timer(`agent-${description.toLowerCase().replace(/\s+/g, '-')}`);
  const fullPrompt = context ? `${context}\n\n${prompt}` : prompt;
  const execContext = detectExecutionContext(description);
  const progress = createProgressManager(
    { description, useCleanOutput: execContext.useCleanOutput },
    global.SHANNON_DISABLE_LOADER ?? false
  );
  const auditLogger = createAuditLogger(auditSession);
  const model = resolveCodexModel(modelTier);

  logger.info(`Running Codex: ${description}...`);

  progress.start();

  const { codexHome, cleanup } = await prepareCodexHome(sourceDir, agentName, logger);
  const lastMessagePath = path.join(codexHome, 'last-message.txt');
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--full-auto',
    '--sandbox',
    'danger-full-access',
    '--output-last-message',
    lastMessagePath,
    '--cd',
    sourceDir,
  ];

  if (model) {
    args.push('--model', model);
  }

  args.push(fullPrompt);

  let turnCount = 0;
  let errorMessage = '';
  let stderrOutput = '';

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('codex', args, {
        cwd: sourceDir,
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdoutBuffer = '';
      const eventPromises: Promise<void>[] = [];

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          try {
            const event = JSON.parse(trimmed) as CodexEvent;
            if (event.type === 'turn.completed') {
              turnCount += 1;
            }

            if (event.type === 'error' && event.error?.message) {
              errorMessage = event.error.message;
            }

            eventPromises.push(
              handleCodexEvent(
                event,
                Math.max(turnCount, 1),
                description,
                logger,
                auditLogger,
                execContext,
                progress
              ).catch((handlerError) => {
                logger.warn(`Failed to handle Codex event: ${handlerError}`);
              })
            );
          } catch {
            logger.info(`Non-JSON Codex stdout: ${trimmed.slice(0, 200)}`);
          }
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderrOutput += chunk;
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('close', (code) => {
        if (stdoutBuffer.trim()) {
          logger.info(`Trailing Codex stdout: ${stdoutBuffer.trim().slice(0, 200)}`);
        }

        void Promise.all(eventPromises).then(() => {
          if (code === 0) {
            resolve();
            return;
          }

          const combinedError = errorMessage || stderrOutput.trim() || `codex exec failed with exit code ${code ?? 'unknown'}`;
          reject(new Error(combinedError));
        }).catch((promiseError) => {
          reject(promiseError);
        });
      });
    });

    let result = 'Completed';
    if (await pathExists(lastMessagePath)) {
      const lastMessage = await fs.readFile(lastMessagePath, 'utf8');
      if (lastMessage.trim()) {
        result = lastMessage.trim();
      }
    }

    const duration = timer.stop();
    progress.finish(formatCompletionMessage(execContext, description, turnCount, duration));

    return {
      result,
      success: true,
      duration,
      turns: turnCount,
      cost: 0,
      model: model || 'codex-cli',
      partialCost: 0,
      apiErrorDetected: false,
    };
  } catch (error) {
    const duration = timer.stop();
    const err = error instanceof Error ? error : new Error(String(error));
    const retryable = isRetryableCodexError(err.message);

    await auditLogger.logError(err, duration, turnCount);
    progress.stop();
    outputLines(formatErrorOutput(err, execContext, description, duration, sourceDir, retryable));

    return {
      error: err.message,
      errorType: err.constructor.name,
      prompt: fullPrompt.slice(0, 100) + '...',
      success: false,
      duration,
      cost: 0,
      model: model || 'codex-cli',
      retryable,
    };
  } finally {
    await cleanup();
  }
}
