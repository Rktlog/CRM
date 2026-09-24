-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "contact_name" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "next_follow_up_at" TIMESTAMP(3),
ADD COLUMN     "phone" TEXT;
