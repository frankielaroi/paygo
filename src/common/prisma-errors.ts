import { Prisma } from '../generated/prisma/client';

/**
 * True for a unique constraint violation (P2002). Services catch it where a race could slip past
 * their own pre-checks, and turn it into a 409 with a message that names the resource.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
