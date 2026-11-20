import { describe, expect, it } from 'vitest';
import { Argon2PasswordHasher } from '../../../src/modules/identity/adapters/crypto/argon2-password-hasher';

describe('Argon2PasswordHasher', () => {
  it('hashes passwords using Argon2id with production baseline configuration', async () => {
    const hasher = new Argon2PasswordHasher({ memoryCost: 8 * 1024, timeCost: 2 });
    const plain = 'P@ssword123456';
    const hash = await hasher.hash(plain);

    expect(hash).toContain('$argon2id$');
    expect(await hasher.verify(hash, plain)).toBe(true);
    expect(await hasher.verify(hash, 'wrong-password')).toBe(false);
  });

  it('returns false when verifying an invalid or malformed hash without throwing', async () => {
    const hasher = new Argon2PasswordHasher();
    expect(await hasher.verify('malformed-hash', 'password')).toBe(false);
    expect(await hasher.verify('', 'password')).toBe(false);
  });

  it('produces expected configuration string with default options', async () => {
    const hasher = new Argon2PasswordHasher();
    const hash = await hasher.hash('secure_password_test');
    expect(hash).toContain('$argon2id$v=19$m=19456,t=2,p=1$');
    expect(await hasher.verify(hash, 'secure_password_test')).toBe(true);
  });
});
