-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'DEFAULTED', 'REPOSSESSED');

-- CreateEnum
CREATE TYPE "LoanFrequency" AS ENUM ('DAILY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('APPLIED', 'UNALLOCATED');

-- CreateEnum
CREATE TYPE "LedgerAccount" AS ENUM ('LOAN_RECEIVABLE', 'FINANCED_ASSETS', 'PROVIDER_CLEARING', 'UNALLOCATED_FUNDS', 'RIDER_CREDIT');

-- CreateEnum
CREATE TYPE "LedgerTransactionType" AS ENUM ('LOAN_ORIGINATION', 'PAYMENT_RECEIVED', 'PAYMENT_ALLOCATED');

-- CreateTable
CREATE TABLE "loans" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "bikeId" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "status" "LoanStatus" NOT NULL DEFAULT 'ACTIVE',
    "currency" CHAR(3) NOT NULL,
    "principalMinor" INTEGER NOT NULL,
    "downPaymentMinor" INTEGER NOT NULL DEFAULT 0,
    "installmentMinor" INTEGER NOT NULL,
    "frequency" "LoanFrequency" NOT NULL,
    "graceDays" INTEGER NOT NULL,
    "firstDueDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "installmentCount" INTEGER NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedById" UUID,
    "closedReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_installments" (
    "id" UUID NOT NULL,
    "loanId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "paidMinor" INTEGER NOT NULL DEFAULT 0,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "loan_installments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerReference" TEXT NOT NULL,
    "providerTransactionId" TEXT,
    "channel" TEXT,
    "payerPhone" TEXT,
    "amountMinor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "PaymentStatus" NOT NULL,
    "statusReason" TEXT,
    "loanId" UUID,
    "overpaidMinor" INTEGER NOT NULL DEFAULT 0,
    "recordedById" UUID,
    "allocatedById" UUID,
    "allocatedAt" TIMESTAMP(3),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "installmentId" UUID NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_transactions" (
    "id" UUID NOT NULL,
    "type" "LedgerTransactionType" NOT NULL,
    "description" TEXT NOT NULL,
    "loanId" UUID,
    "paymentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "account" "LedgerAccount" NOT NULL,
    "loanId" UUID,
    "debitMinor" INTEGER NOT NULL DEFAULT 0,
    "creditMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "loans_customerId_idx" ON "loans"("customerId");

-- CreateIndex
CREATE INDEX "loans_bikeId_idx" ON "loans"("bikeId");

-- CreateIndex
CREATE INDEX "loans_status_idx" ON "loans"("status");

-- CreateIndex
CREATE INDEX "loan_installments_loanId_dueDate_idx" ON "loan_installments"("loanId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "loan_installments_loanId_sequence_key" ON "loan_installments"("loanId", "sequence");

-- CreateIndex
CREATE INDEX "payments_loanId_paidAt_idx" ON "payments"("loanId", "paidAt");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_providerReference_key" ON "payments"("provider", "providerReference");

-- CreateIndex
CREATE INDEX "payment_allocations_paymentId_idx" ON "payment_allocations"("paymentId");

-- CreateIndex
CREATE INDEX "payment_allocations_installmentId_idx" ON "payment_allocations"("installmentId");

-- CreateIndex
CREATE INDEX "ledger_transactions_loanId_idx" ON "ledger_transactions"("loanId");

-- CreateIndex
CREATE INDEX "ledger_transactions_paymentId_idx" ON "ledger_transactions"("paymentId");

-- CreateIndex
CREATE INDEX "ledger_entries_transactionId_idx" ON "ledger_entries"("transactionId");

-- CreateIndex
CREATE INDEX "ledger_entries_loanId_account_idx" ON "ledger_entries"("loanId", "account");

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_bikeId_fkey" FOREIGN KEY ("bikeId") REFERENCES "bikes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "bike_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_installments" ADD CONSTRAINT "loan_installments_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_allocatedById_fkey" FOREIGN KEY ("allocatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "loan_installments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written: rules Prisma cannot express. The service checks all of these too; the database
-- is the last line, so a bug in application code fails loudly instead of corrupting money.
-- ---------------------------------------------------------------------------

-- Loan terms.
ALTER TABLE "loans" ADD CONSTRAINT "loans_amounts_check" CHECK (
  "principalMinor" > 0
  AND "installmentMinor" > 0
  AND "installmentMinor" <= "principalMinor"
  AND "downPaymentMinor" >= 0
  AND "graceDays" BETWEEN 0 AND 60
  AND "installmentCount" > 0
  AND "endDate" >= "firstDueDate"
);

-- At most one open (ACTIVE or DEFAULTED) loan per bike.
CREATE UNIQUE INDEX "loans_open_bike_key"
  ON "loans" ("bikeId") WHERE "status" IN ('ACTIVE', 'DEFAULTED');

-- An installment is never paid below zero or beyond its amount.
ALTER TABLE "loan_installments" ADD CONSTRAINT "loan_installments_paid_check"
  CHECK ("amountMinor" > 0 AND "paidMinor" >= 0 AND "paidMinor" <= "amountMinor");

ALTER TABLE "payments" ADD CONSTRAINT "payments_amounts_check"
  CHECK ("amountMinor" > 0 AND "overpaidMinor" >= 0 AND "overpaidMinor" <= "amountMinor");

ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_amount_check"
  CHECK ("amountMinor" > 0);

-- Each ledger entry is exactly one of a debit or a credit.
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_one_side_check" CHECK (
  ("debitMinor" > 0 AND "creditMinor" = 0) OR ("creditMinor" > 0 AND "debitMinor" = 0)
);

-- Financial history is append-only. Corrections are new, reversing transactions.
CREATE FUNCTION "refuse_financial_history_change"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_transactions_append_only"
  BEFORE UPDATE OR DELETE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION "refuse_financial_history_change"();
CREATE TRIGGER "ledger_entries_append_only"
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "refuse_financial_history_change"();
CREATE TRIGGER "payment_allocations_append_only"
  BEFORE UPDATE OR DELETE ON "payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION "refuse_financial_history_change"();

-- Every ledger transaction balances, per currency, checked when the database transaction
-- commits (deferred), so the entries of one ledger transaction can be inserted one by one.
CREATE FUNCTION "check_ledger_transaction_balanced"() RETURNS trigger AS $$
DECLARE
  unbalanced TEXT;
BEGIN
  SELECT "currency" INTO unbalanced
  FROM "ledger_entries"
  WHERE "transactionId" = NEW."transactionId"
  GROUP BY "currency"
  HAVING SUM("debitMinor") <> SUM("creditMinor")
  LIMIT 1;

  IF unbalanced IS NOT NULL THEN
    RAISE EXCEPTION 'Ledger transaction % does not balance in %', NEW."transactionId", unbalanced;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ledger_entries_balanced"
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_ledger_transaction_balanced"();
