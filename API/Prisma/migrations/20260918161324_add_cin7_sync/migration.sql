/*
  Warnings:

  - A unique constraint covering the columns `[dear_customer_id]` on the table `accounts` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "dear_customer_id" TEXT;

-- CreateTable
CREATE TABLE "sync_state" (
    "key" TEXT NOT NULL,
    "last_synced_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_state_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_dear_customer_id_key" ON "accounts"("dear_customer_id");
