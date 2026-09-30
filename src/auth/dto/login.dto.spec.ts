import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto } from './login.dto';

/** The properties that failed validation, as the global ValidationPipe would see them. */
async function failures(body: object): Promise<string[]> {
  const errors = await validate(plainToInstance(LoginDto, body));
  return errors.map((error) => error.property);
}

describe('LoginDto', () => {
  const password = 'correct-horse';

  it('accepts an email alone', async () => {
    expect(await failures({ email: 'admin@paygo.test', password })).toEqual([]);
  });

  it('accepts a phone alone, ignoring spaces and dashes', async () => {
    const body = { phone: '024 123-4567', password };

    expect(await failures(body)).toEqual([]);
    expect(plainToInstance(LoginDto, body).phone).toBe('0241234567');
  });

  it('requires one of email or phone', async () => {
    expect(await failures({ password })).toEqual(
      expect.arrayContaining(['email', 'phone']),
    );
  });

  it('rejects a malformed phone', async () => {
    expect(await failures({ phone: '024-CALL-ME', password })).toEqual([
      'phone',
    ]);
  });

  it('rejects a malformed email', async () => {
    expect(await failures({ email: 'not-an-email', password })).toEqual([
      'email',
    ]);
  });
});
