import { promises as fs } from 'node:fs';
import path from 'node:path';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS' | 'STEP';

class Logger {
  private logFilePath: string;

  constructor() {
    const logsDir = path.resolve(process.cwd(), 'logs');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logFilePath = path.join(logsDir, `${timestamp}.log`);
    fs.mkdir(logsDir, { recursive: true }).catch(() => {/* ignore */});
  }

  private format(level: LogLevel, message: string): string {
    return `[${level}] ${new Date().toISOString()} - ${message}`;
  }

  private async write(line: string, data?: unknown): Promise<void> {
    const output = data ? `${line}\n  → ${JSON.stringify(data, null, 2)}\n` : `${line}\n`;
    await fs.appendFile(this.logFilePath, output, 'utf8');
  }

  private async log(level: LogLevel, message: string, data?: unknown): Promise<void> {
    const formatted = this.format(level, message);
    const consoleFn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
    consoleFn(formatted);
    if (data) consoleFn('  →', data);
    await this.write(formatted, data);
  }

  info(msg: string, data?: unknown) { return this.log('INFO', msg, data); }
  warn(msg: string, data?: unknown) { return this.log('WARN', msg, data); }
  error(msg: string, data?: unknown) { return this.log('ERROR', msg, data); }
  success(msg: string, data?: unknown) { return this.log('SUCCESS', msg, data); }
  step(step: number, total: number, msg: string) {
    return this.log('STEP', `[${step}/${total}] ${msg}`);
  }
}

export const logger = new Logger(); 