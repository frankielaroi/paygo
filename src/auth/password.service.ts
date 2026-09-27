import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Password hashing, isolated so the algorithm and its parameters live in one place and
 * can be changed without touching the auth flow.
 */
@Injectable()
export class PasswordService {
  private readonly options: argon2.HashOptions = {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  };

  hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, this.options);
  }

  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plaintext);
    } catch {
      // A malformed or truncated hash in the database must read as "wrong password",
      // not as a 500 that tells an attacker the account is special.
      return false;
    }
  }
}
