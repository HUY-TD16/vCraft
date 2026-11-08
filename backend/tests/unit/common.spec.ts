import { type ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/common/config/app-config';
import { InputValidationError, ZodValidationPipe } from '../../src/common/http/pipes/zod-validation.pipe';
import { ApiProblem } from '../../src/common/http/filters/api-problem';
import { ProblemDetailsFilter } from '../../src/common/http/filters/problem-details.filter';

describe('startup configuration', () => {
  it('lists invalid variables without including their values', () => {
    expect(() => readConfig({ DATABASE_URL: 'private-value', PORT: '65536' }))
      .toThrow(/^Missing or invalid environment variables: DATABASE_URL, SESSION_SECRET, PORT$/);
  });

  it('uses the Compose port default and normalizes the origin', () => {
    const config = readConfig({
      DATABASE_URL: 'postgresql://user:password@postgres:5432/vcraft?schema=public',
      SESSION_SECRET: 'x'.repeat(32), APP_ORIGIN: 'https://example.test/',
    });
    expect(config.PORT).toBe(3000);
    expect(config.APP_ORIGIN).toBe('https://example.test');
  });
});

describe('DTO validation', () => {
  const pipe = new ZodValidationPipe(z.strictObject({
    title: z.string().trim().min(1),
    items: z.array(z.strictObject({ quantity: z.int().positive() })),
  }));

  it('returns the transformed DTO', () => {
    expect(pipe.transform({ title: ' Test ', items: [] })).toEqual({ title: 'Test', items: [] });
  });

  it('reports nested fields and escapes unknown keys as JSON Pointers', () => {
    let error: unknown;
    try { pipe.transform({ title: ' ', items: [{ quantity: 0 }], 'a/b~c': 'private-value' }); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(InputValidationError);
    const errors = (error as InputValidationError).errors;
    expect(errors.map(issue => issue.field)).toEqual(['/title', '/items/0/quantity', '/a~1b~0c']);
    expect(JSON.stringify(errors)).not.toContain('private-value');
  });
});

describe('Problem Details', () => {
  function respond(error: Error) {
    const response = {
      status: vi.fn().mockReturnThis(), type: vi.fn().mockReturnThis(),
      setHeader: vi.fn(), removeHeader: vi.fn(), json: vi.fn(),
    };
    const host = { switchToHttp: () => ({ getResponse: () => response }) } as ArgumentsHost;
    new ProblemDetailsFilter().catch(error, host);
    return response;
  }

  it('preserves field errors in the public validation response', () => {
    const errors = [{ field: '/quantity', message: 'Số lượng không hợp lệ.' }];
    const response = respond(new InputValidationError(errors));
    expect(response.type).toHaveBeenCalledWith('application/problem+json');
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 400, code: 'INVALID_INPUT', errors, tracking_id: expect.any(String),
    }));
  });

  it('preserves the business code for errors sharing an HTTP status', () => {
    expect(respond(new ApiProblem('QUOTE_EXPIRED')).json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 422, code: 'QUOTE_EXPIRED' }),
    );
    expect(respond(new ApiProblem('RATE_LIMIT_EXCEEDED', 10)).setHeader)
      .toHaveBeenCalledWith('Retry-After', 10);
  });
});
