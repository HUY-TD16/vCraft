import { toBigIntId } from '../application/helpers/find-or-throw';

export interface AuditLogData {
  actorId?: bigint | string | null;
  targetAccountId: bigint | string;
  eventType: string;
  authVersionBefore?: number | null;
  authVersionAfter: number;
  reason?: string | null;
  verificationEvidence?: string | null;
  ipAddress?: string | null;
}

export interface SecurityAuditClient {
  securityAuditLog: {
    create(args: {
      data: {
        actor_id: bigint | null;
        target_account_id: bigint;
        event_type: string;
        auth_version_before: number | null;
        auth_version_after: number;
        reason?: string | null;
        verification_evidence?: string | null;
        ip_address?: string | null;
      };
    }): Promise<unknown>;
  };
}

export async function logSecurityAudit(
  client: SecurityAuditClient,
  data: AuditLogData,
): Promise<void> {
  await client.securityAuditLog.create({
    data: {
      actor_id: data.actorId != null ? toBigIntId(data.actorId) : null,
      target_account_id: toBigIntId(data.targetAccountId),
      event_type: data.eventType,
      auth_version_before: data.authVersionBefore ?? null,
      auth_version_after: data.authVersionAfter,
      reason: data.reason ?? null,
      verification_evidence: data.verificationEvidence ?? null,
      ip_address: data.ipAddress ?? null,
    },
  });
}
