-- Writing off a loan: a closing status, and two ledger accounts so the loss is recorded
-- without crediting LOAN_RECEIVABLE, whose credits must stay "money paid".
-- The open-loan index ("loans_open_bike_key") already covers only ACTIVE and DEFAULTED, so a
-- written-off loan frees its bike with no change there.

-- AlterEnum
ALTER TYPE "LoanStatus" ADD VALUE 'WRITTEN_OFF';

-- AlterEnum
ALTER TYPE "LedgerAccount" ADD VALUE 'LOAN_WRITTEN_OFF';
ALTER TYPE "LedgerAccount" ADD VALUE 'WRITE_OFF_LOSS';

-- AlterEnum
ALTER TYPE "LedgerTransactionType" ADD VALUE 'LOAN_WRITE_OFF';
