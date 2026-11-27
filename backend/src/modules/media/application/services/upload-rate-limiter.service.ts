import { Injectable } from '@nestjs/common';
import type { Id } from '../../../../common/application/types/contract-types';
import { ApiProblem } from '../../../../common/http/filters/api-problem';
import { UPLOAD_LIMITS } from '../../domain/value-objects/image-limits';

const WINDOW_MS = 60_000;

/** Per-process MVP limiter; upload throttling must move to shared storage before horizontal scaling. */
@Injectable()
export class UploadRateLimiterService {
  private readonly attempts = new Map<Id, number[]>();
  private readonly active = new Map<Id, number>();

  acquire(accountId: Id, now = Date.now()): () => void {
    const recent = (this.attempts.get(accountId) ?? []).filter(at => now - at < WINDOW_MS);
    if (recent.length >= UPLOAD_LIMITS.maxUploadsPerMinutePerAccount) {
      this.attempts.set(accountId, recent);
      const retryAfter = Math.max(1, Math.ceil((recent[0]! + WINDOW_MS - now) / 1000));
      throw new ApiProblem('RATE_LIMIT_EXCEEDED', retryAfter);
    }
    if ((this.active.get(accountId) ?? 0) >= UPLOAD_LIMITS.maxConcurrentProcessingPerAccount) {
      throw new ApiProblem('RATE_LIMIT_EXCEEDED', 1);
    }

    recent.push(now);
    this.attempts.set(accountId, recent);
    this.active.set(accountId, (this.active.get(accountId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.active.get(accountId) ?? 0;
      if (count <= 1) this.active.delete(accountId);
      else this.active.set(accountId, count - 1);
    };
  }
}
