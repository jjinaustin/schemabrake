-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'ADMIN';

-- AlterTable
ALTER TABLE "User" DROP COLUMN "legacy",
ADD COLUMN     "plan" TEXT NOT NULL DEFAULT 'free',
ADD COLUMN     "stripeCustomerId" TEXT NOT NULL,
ALTER COLUMN "age" SET DATA TYPE BIGINT;

-- DropTable
DROP TABLE "Audit";

-- CreateTable
CREATE TABLE "Invoice" (
    "id" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Invoice_total_idx" ON "Invoice"("total");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_age_idx" ON "User"("age");

