/*
  Warnings:

  - The values [product_selected] on the enum `Stage` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "Stage_new" AS ENUM ('new_lead', 'approached', 'quote_sent', 'payment_cleared', 'dispatched');
ALTER TABLE "crm"."accounts" ALTER COLUMN "stage" DROP DEFAULT;
ALTER TABLE "accounts" ALTER COLUMN "stage" TYPE "Stage_new" USING ("stage"::text::"Stage_new");
ALTER TYPE "Stage" RENAME TO "Stage_old";
ALTER TYPE "Stage_new" RENAME TO "Stage";
DROP TYPE "crm"."Stage_old";
ALTER TABLE "accounts" ALTER COLUMN "stage" SET DEFAULT 'new_lead';
COMMIT;
