import type { LoggerService } from '@nestjs/common';
import { requestContext } from './request-context';

type Level = 'debug' | 'info' | 'warn' | 'error';
type Sink = (line: string, done: (error?: Error | null) => void) => void;
const levels: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const allowedFields = new Set(['method', 'route', 'status', 'duration_ms', 'code', 'outcome']);

export class AppLogger implements LoggerService {
  private readonly queue: string[] = [];
  private writing = false;
  private failed = false;
  private dropped = 0;

  constructor(
    private readonly minimum: Level = 'info',
    private readonly sink: Sink = (line, done) => { process.stdout.write(line, done); },
  ) {}

  event(level: Level, event: string, module: string, fields: Record<string, unknown> = {}): void {
    if (levels[level] < levels[this.minimum]) return;
    const context = requestContext.getStore();
    const safeFields = Object.fromEntries(Object.entries(fields).filter(([key, value]) =>
      allowedFields.has(key) && (typeof value === 'number' && Number.isFinite(value)
        || typeof value === 'string' && value.length <= 200),
    ));
    const line = JSON.stringify({
      timestamp: new Date().toISOString(), level, event: event.slice(0, 120), module: module.slice(0, 120),
      ...(context && { request_id: context.requestId }), ...safeFields,
    }) + '\n';
    if (this.queue.length >= 100) { this.dropped++; this.flush(); return; }
    this.queue.push(line);
    this.flush();
  }

  getHealth() {
    return { healthy: !this.failed && this.dropped === 0, queued: this.queue.length, dropped: this.dropped };
  }

  flush(): void {
    if (this.writing || !this.queue.length) return;
    this.writing = true;
    const done = (error?: Error | null) => {
      this.writing = false;
      this.failed = !!error;
      if (!error) { this.queue.shift(); this.flush(); }
    };
    try { this.sink(this.queue[0], done); }
    catch { done(new Error('Log sink unavailable')); }
  }

  log(_message: unknown, context = 'Bootstrap'): void { this.event('info', 'framework_log', context); }
  warn(_message: unknown, context = 'Bootstrap'): void { this.event('warn', 'framework_warning', context); }
  error(_message: unknown, _stack?: string, context = 'Bootstrap'): void { this.event('error', 'framework_error', context); }
  debug(_message: unknown, context = 'Bootstrap'): void { this.event('debug', 'framework_debug', context); }
  verbose(_message: unknown, context = 'Bootstrap'): void { this.event('debug', 'framework_verbose', context); }
  fatal(_message: unknown, context = 'Bootstrap'): void { this.event('error', 'framework_fatal', context); }
}

export const appLogger = new AppLogger();
