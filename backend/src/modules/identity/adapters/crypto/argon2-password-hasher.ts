import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { IPasswordHasher } from '../../application/ports/password-hasher.port';

@Injectable()
export class Argon2PasswordHasher implements IPasswordHasher {
  private readonly options: argon2.Options;

  constructor(options?: Partial<argon2.Options>) {
    this.options = {
      type: argon2.argon2id,
      memoryCost: 19 * 1024,
      timeCost: 2,
      parallelism: 1,
      ...options,
    };
  }

  async hash(password: string): Promise<string> {
    return argon2.hash(password, this.options);
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }
}
