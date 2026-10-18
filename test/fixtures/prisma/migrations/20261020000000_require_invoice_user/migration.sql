-- DropForeignKey
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_userId_fkey";

-- AlterTable
ALTER TABLE "Invoice" ALTER COLUMN "userId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

