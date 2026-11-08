import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'dotenv';
import { type ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError, loadConfig, readConfig } from '../../src/common/config/app-config';
import { BusinessRuleException } from '../../src/common/domain/errors/business-rule.exception';
import { WorkshopSuspended } from '../../src/modules/workshops/domain/errors/workshop-suspended';
import { ProblemDetailsFilter } from '../../src/common/http/filters/problem-details.filter';

const valid = {
  DATABASE_URL: 'postgresql://user:password@postgres:5432/vcraft?schema=public',
  SESSION_SECRET: 'example_session_secret_with_at_least_32_chars',
};

describe('configuration loading', () => {
  it('reads a file while retaining environment overrides, including explicit empty values', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vcraft-config-'));
    const envFile = join(directory, '.env');
    try {
      writeFileSync(envFile, Object.entries({ ...valid, PORT: '3100' }).map(([k, v]) => k + '=' + v).join('\n'));
      const config = loadConfig({ PORT: '3200' }, envFile);
      expect(config.PORT).toBe(3200);
      expect(config.DATABASE_URL).toBe(valid.DATABASE_URL);
      expect(() => loadConfig({ SESSION_SECRET: '' }, envFile)).toThrow(/SESSION_SECRET/);
    } finally {
      unlinkSync(envFile);
      rmdirSync(directory);
    }
  });

  it('supports container variables without a file and freezes the typed result', () => {
    const config = loadConfig({ ...valid }, join(tmpdir(), 'vcraft-config-missing', '.env'));
    expect(config.PORT).toBe(3000);
    expect(Object.isFrozen(config)).toBe(true);
    expect(config.UPLOAD_DIR).toBe(resolve(__dirname, '../../storage/uploads'));
  });

  it.each([
    ['DATABASE_URL', 'postgresql://user:private@localhost/db?schema='],
    ['DATABASE_URL', 'https://example.test/db'],
    ['DATABASE_URL', 'postgresql://user:private@localhost/db#fragment'],
    ['PORT', '0'], ['PORT', '65536'], ['PORT', '3.5'],
    ['SESSION_SECRET', ' '.repeat(40)],
    ['APP_ORIGIN', 'https://example.test/path'], ['NODE_ENV', 'prod'], ['UPLOAD_DIR', ''],
  ])('reports %s without exposing its value', (field, value) => {
    try {
      readConfig({ ...valid, [field]: value });
      throw new Error('Expected configuration to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).fields).toContain(field);
      expect((error as Error).message).toBe('Missing or invalid environment variables: ' + field);
    }
  });

  it('preserves the supplied secret and validates the environment examples', () => {
    const secret = ' ' + valid.SESSION_SECRET + ' ';
    expect(readConfig({ ...valid, SESSION_SECRET: secret }).SESSION_SECRET).toBe(secret);
    const backend = parse(readFileSync(resolve(__dirname, '../../.env.example')));
    const root = parse(readFileSync(resolve(__dirname, '../../../.env.example')));
    expect(() => readConfig(backend)).not.toThrow();
    expect(() => readConfig({ ...root, DATABASE_URL: valid.DATABASE_URL })).not.toThrow();
  });
});

describe('business errors', () => {
  it('retains an internal message and a defensive copy of metadata', () => {
    const ids = ['301'];
    const error = new BusinessRuleException('INVALID_STATE', 'Internal state mismatch', { ids, version: 2 });
    ids.push('302');
    expect(error.message).toBe('Internal state mismatch');
    expect(error.details).toEqual({ ids: ['301'], version: 2 });
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(Object.isFrozen(error.details.ids)).toBe(true);
    expect(new BusinessRuleException('INVALID_STATE').message).toBe('INVALID_STATE');
  });

  it('maps module-specific errors without serializing internal data', () => {
    const response = { status: vi.fn().mockReturnThis(), type: vi.fn().mockReturnThis(), json: vi.fn() };
    const host = { switchToHttp: () => ({ getResponse: () => response }) } as ArgumentsHost;
    const filter = new ProblemDetailsFilter();
    const error = new WorkshopSuspended();
    expect(error).toBeInstanceOf(BusinessRuleException);
    expect(error.name).toBe('WorkshopSuspended');
    filter.catch(error, host);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ status: 422, code: 'WORKSHOP_SUSPENDED' }));
    filter.catch(new BusinessRuleException('INVALID_STATE', 'private-message', { buyerPhone: 'private-phone' }), host);
    expect(JSON.stringify(response.json.mock.calls)).not.toMatch(/private-message|private-phone|buyerPhone/);
  });
});
